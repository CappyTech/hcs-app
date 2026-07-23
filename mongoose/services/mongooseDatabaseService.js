__dotenv.config();
import fs from 'fs';
import path from 'path';
import tunnel from 'tunnel-ssh';
import mongoose from 'mongoose';
import logger from '../../services/loggerService.js';
import configService from '../../services/configService.js';
import auditPlugin from './auditPlugin.js';
import __dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

// INTERNAL models excluded from the audit trail: the audit log itself, plus
// high-frequency infrastructure writes (session activity) that would flood it.
const AUDIT_EXCLUDE_MODELS = (process.env.AUDIT_EXCLUDE_MODELS || 'auditLog,session')
  .split(',').map((s) => s.trim()).filter(Boolean);

const mdb = { REST: {}, INTERNAL: {}, PAPERLESS: {} };
let isConnected = false;
let sshServer = null;

const isTunnelEnabled = configService.get('SSH_TUNNEL_ENABLED') === 'true';

function getUriWithDb(baseUri, dbName) {
  // Replace or append the db segment before query string, robust to URIs without a path
  if (!baseUri) return '';
  const [left, query = ''] = baseUri.split('?');
  const trimmed = left.replace(/\/+$/, '');
  const protoMatch = /^mongodb(\+srv)?:\/\//.test(trimmed);
  if (protoMatch) {
    // afterHost: portion after protocol+host (may be empty or like '/admin')
    const afterHost = trimmed.replace(/^mongodb(\+srv)?:\/\/[^/]+/, '');
    let newLeft;
    if (afterHost) {
      // Replace last path segment with dbName
      newLeft = trimmed.replace(/\/(?:[^/]*)$/, `/${dbName}`);
    } else {
      // No path present; append '/dbName'
      newLeft = `${trimmed}/${dbName}`;
    }
    return query ? `${newLeft}?${query}` : newLeft;
  }
  const newLeft = `${trimmed}/${dbName}`;
  return query ? `${newLeft}?${query}` : newLeft;
}

function buildBaseMongoUriFromParts() {
  // Build a base Mongo URI from discrete config values when MONGO_URI is not provided
  const host = (configService.get('MONGO_HOST', 'localhost')).trim();
  const port = parseInt(configService.get('MONGO_PORT', '27017'), 10);
  const user = configService.get('MONGO_USER') ? String(configService.get('MONGO_USER')) : '';
  const pass = configService.get('MONGO_PASS') ? String(configService.get('MONGO_PASS')) : '';
  const authSource = (configService.get('MONGO_AUTH_SOURCE', 'admin')).trim();

  let left;
  if (user && pass) {
    // Encode credentials to support special characters
    const encUser = encodeURIComponent(user);
    const encPass = encodeURIComponent(pass);
    left = `mongodb://${encUser}:${encPass}@${host}:${port}`;
    return `${left}?authSource=${encodeURIComponent(authSource)}`;
  }
  // No auth
  left = `mongodb://${host}:${port}`;
  return left;
}

async function createNamespace(ns, connection) {
  const baseDir = path.join(__dirname, '..', 'models', 'mongoose', ns);
  const files = fs.existsSync(baseDir) ? fs.readdirSync(baseDir) : [];
  // Ensure namespace bucket exists
  if (!mdb[ns]) mdb[ns] = {};
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const modelModule = await import(pathToFileURL(path.join(baseDir, file)).href);
    const { modelName, schema } = modelModule.default ?? modelModule;
    if (!modelName || !schema) {
      logger.warn(`Skipping model in ${ns}: ${file} (missing modelName/schema)`);
      continue;
    }
    // Attach the audit trail to INTERNAL models, skipping the audit log itself
    // and high-frequency infrastructure collections (e.g. session writes).
    if (ns === 'INTERNAL' && !AUDIT_EXCLUDE_MODELS.includes(modelName)) {
      schema.plugin(auditPlugin, { modelName });
    }
    connection.model(modelName, schema);
    mdb[ns][modelName] = connection.model(modelName);
    if (process.env.DEBUG) logger.info(`Model loaded [${ns}]: ${modelName}`);
  }
  mdb[ns].connection = connection;
}

mdb.connect = async () => {
  try {
    if (isConnected && mdb.REST.connection && mdb.INTERNAL.connection && mdb.PAPERLESS.connection) {
      return mdb;
    }
    let localPort = null;
    if (isTunnelEnabled) {
      const getPort = (await import('get-port')).default;
      localPort = await getPort({ port: Array.from({ length: 1000 }, (_, i) => 27000 + i) });
      const sshConfig = {
        username: configService.get('SSH_USER'),
        host: configService.get('SSH_HOST'),
        port: parseInt(configService.get('SSH_PORT', '22')),
        dstHost: configService.get('SSH_REMOTE_HOST', '127.0.0.1'),
        dstPort: parseInt(configService.get('SSH_REMOTE_PORT', '27017')),
        localHost: '127.0.0.1',
        localPort,
        keepAlive: true,
      };
      const sshKeyPath = configService.get('SSH_KEY_PATH')?.trim();
      const sshPass = configService.get('SSH_PASS')?.trim();
      if (sshKeyPath) {
        try { sshConfig.privateKey = fs.readFileSync(sshKeyPath); } catch (err) { logger.error(`[mongooseDatabaseService] Failed to read SSH key at ${sshKeyPath}: ${err.message}`); throw err; }
      } else if (sshPass) {
        sshConfig.password = sshPass;
      } else {
        const msg = '[mongooseDatabaseService] No SSH auth method provided. Set SSH_KEY_PATH or SSH_PASS in .env';
        logger.error(msg);
        throw new Error(msg);
      }

      await new Promise((resolve, reject) => {
        tunnel(sshConfig, (err, server) => {
          if (err) {
            logger.error('[mongooseDatabaseService] SSH tunnel error: ' + err.message);
            return reject(err);
          }
          sshServer = server;
          // Prevent unhandled 'error' events from crashing the process (e.g., ECONNRESET during shutdown)
          server.on('error', (e) => {
            const code = e?.code || e?.errno;
            const level = e?.level;
            if (code === 'ECONNRESET' || code === 'EPIPE' || level === 'client-socket') {
              logger.warn('[mongooseDatabaseService] SSH tunnel socket error ignored: ' + (code || level));
              return;
            }
            logger.error('[mongooseDatabaseService] SSH tunnel server error: ' + e);
          });
          server.on('close', () => logger.info('[mongooseDatabaseService] SSH tunnel server closed'));
          logger.info(`[mongooseDatabaseService] SSH tunnel established on port ${localPort}`);
          resolve();
        });
      });
    }

    // Build URIs per namespace
    const restDb = configService.get('MONGO_DBNAME_REST', configService.get('MONGO_DBNAME', 'rest'));
    const internalDb = configService.get('MONGO_DBNAME_INTERNAL', configService.get('MONGO_DBNAME', 'internal'));
    const paperlessDb = configService.get('MONGO_DBNAME_PAPERLESS', 'paperless');

    let restUri, internalUri, paperlessUri;

    if (isTunnelEnabled) {
      const mongoUser = encodeURIComponent(configService.get('MONGO_USER', ''));
      const mongoPass = encodeURIComponent(configService.get('MONGO_PASS', ''));
      restUri = `mongodb://${mongoUser}:${mongoPass}@127.0.0.1:${localPort}/${restDb}?authSource=admin`;
      internalUri = `mongodb://${mongoUser}:${mongoPass}@127.0.0.1:${localPort}/${internalDb}?authSource=admin`;
      paperlessUri = `mongodb://${mongoUser}:${mongoPass}@127.0.0.1:${localPort}/${paperlessDb}?authSource=admin`;
      if (configService.get('DEBUG')) logger.info('[mongooseDatabaseService] Connected to MongoDB via SSH tunnel');
    } else {
      // Prefer explicit MONGO_URI; otherwise build from parts
      const rawUri = configService.get('MONGO_URI', '');
      const baseUri = (rawUri && rawUri.trim()) || buildBaseMongoUriFromParts();
      restUri = getUriWithDb(baseUri, restDb);
      internalUri = getUriWithDb(baseUri, internalDb);
      paperlessUri = getUriWithDb(baseUri, paperlessDb);
      if (configService.get('DEBUG')) logger.info('[mongooseDatabaseService] Connecting to MongoDB via ' + (rawUri ? 'MONGO_URI' : 'MONGO_HOST/PORT/USER/PASS'));
    }

    const restConn = mongoose.createConnection(restUri);
    const internalConn = mongoose.createConnection(internalUri);
    const paperlessConn = mongoose.createConnection(paperlessUri);

    await Promise.all([
      new Promise((res, rej) => { restConn.once('open', res); restConn.on('error', rej); }),
      new Promise((res, rej) => { internalConn.once('open', res); internalConn.on('error', rej); }),
      new Promise((res, rej) => { paperlessConn.once('open', res); paperlessConn.on('error', rej); })
    ]);

    if (process.env.DEBUG) {
      logger.info('[mongooseDatabaseService] REST connection open');
      logger.info('[mongooseDatabaseService] INTERNAL connection open');
      logger.info('[mongooseDatabaseService] PAPERLESS connection open');
    }

    // Load models into each namespace
    await createNamespace('REST', restConn);
    await createNamespace('INTERNAL', internalConn);
    await createNamespace('PAPERLESS', paperlessConn);

    isConnected = true;
    return mdb;
  } catch (err) {
    logger.error('[mongooseDatabaseService] Database connection setup failed: ' + err.message);
    throw err;
  }
};

const cleanup = async () => {
  logger.info('[mongooseDatabaseService] Cleaning up database and SSH tunnel...');
  try {
    try { await mdb.REST?.connection?.close(); } catch {}
    try { await mdb.INTERNAL?.connection?.close(); } catch {}
    try { await mdb.PAPERLESS?.connection?.close(); } catch {}

    if (sshServer && sshServer.close) {
      sshServer.close();
      logger.info('[mongooseDatabaseService] SSH tunnel closed');
    }
  } catch (err) {
    logger.error('[mongooseDatabaseService] Cleanup error: ' + err.message);
  } finally {
    logger.info('[mongooseDatabaseService] Cleanup complete');
  }
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

export default mdb;
