'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel-ssh');
const mongoose = require('mongoose');
const logger = require('../../services/loggerService');

const mdb = { REST: {}, INTERNAL: {}, PAPERLESS: {} };
let isConnected = false;
let sshServer = null;

const isTunnelEnabled = process.env.SSH_TUNNEL_ENABLED === 'true';

function getUriWithDb(baseUri, dbName) {
  // If full URI is provided, replace/append db segment before query
  if (!baseUri) return '';
  const [left, query = ''] = baseUri.split('?');
  const trimmed = left.replace(/\/$/, '');
  const newLeft = trimmed.includes('mongodb://')
    ? `${trimmed.substring(0, trimmed.lastIndexOf('/'))}/${dbName}`
    : `${trimmed}/${dbName}`;
  return query ? `${newLeft}?${query}` : newLeft;
}

async function createNamespace(ns, connection) {
  const baseDir = path.join(__dirname, '..', 'models', 'mongoose', ns);
  const files = fs.existsSync(baseDir) ? fs.readdirSync(baseDir) : [];
  // Ensure namespace bucket exists
  if (!mdb[ns]) mdb[ns] = {};
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const { modelName, schema } = require(path.join(baseDir, file));
    if (!modelName || !schema) {
      logger.warn(`Skipping model in ${ns}: ${file} (missing modelName/schema)`);
      continue;
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
        username: process.env.SSH_USER,
        host: process.env.SSH_HOST,
        port: parseInt(process.env.SSH_PORT || '22'),
        dstHost: process.env.SSH_REMOTE_HOST || '127.0.0.1',
        dstPort: parseInt(process.env.SSH_REMOTE_PORT || '27017'),
        localHost: '127.0.0.1',
        localPort,
        keepAlive: true,
      };
      const sshKeyPath = process.env.SSH_KEY_PATH?.trim();
      const sshPass = process.env.SSH_PASS?.trim();
      if (sshKeyPath) {
        try { sshConfig.privateKey = fs.readFileSync(sshKeyPath); } catch (err) { logger.error(`❌ Failed to read SSH key at ${sshKeyPath}: ${err.message}`); throw err; }
      } else if (sshPass) {
        sshConfig.password = sshPass;
      } else {
        const msg = '❌ No SSH auth method provided. Set SSH_KEY_PATH or SSH_PASS in .env';
        logger.error(msg);
        throw new Error(msg);
      }

      await new Promise((resolve, reject) => {
        tunnel(sshConfig, (err, server) => {
          if (err) {
            logger.error('❌ SSH tunnel error: ' + err.message);
            return reject(err);
          }
          sshServer = server;
          logger.info(`🔐 SSH tunnel established on port ${localPort}`);
          resolve();
        });
      });
    }

    // Build URIs per namespace
    const restDb = process.env.MONGO_DBNAME_REST || process.env.MONGO_DBNAME || 'rest';
    const internalDb = process.env.MONGO_DBNAME_INTERNAL || process.env.MONGO_DBNAME || 'internal';
    const paperlessDb= process.env.MONGO_DBNAME_PAPERLESS || 'paperless';

    let restUri, internalUri, paperlessUri;

    if (isTunnelEnabled) {
      restUri = `mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@127.0.0.1:${localPort}/${restDb}?authSource=admin`;
      internalUri = `mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@127.0.0.1:${localPort}/${internalDb}?authSource=admin`;
      paperlessUri = `mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@127.0.0.1:${localPort}/${paperlessDb}?authSource=admin`;
      if (process.env.DEBUG) logger.info('✅ Connected to MongoDB via SSH tunnel');
    } else {
      const baseUri = process.env.MONGO_URI;
      if (!baseUri) throw new Error('MONGO_URI not set');
      restUri = getUriWithDb(baseUri, restDb);
      internalUri = getUriWithDb(baseUri, internalDb);
      paperlessUri = getUriWithDb(baseUri, paperlessDb);
      if (process.env.DEBUG) logger.info('✅ Connecting to MongoDB via MONGO_URI');
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
      logger.info('✅ REST connection open');
      logger.info('✅ INTERNAL connection open');
      logger.info('✅ PAPERLESS connection open');
    }

    // Load models into each namespace
    await createNamespace('REST', restConn);
    await createNamespace('INTERNAL', internalConn);
    await createNamespace('PAPERLESS', paperlessConn);

    isConnected = true;
    return mdb;
  } catch (err) {
    logger.error('❌ Database connection setup failed: ' + err.message);
    throw err;
  }
};

const cleanup = async () => {
  logger.info('🧹 Cleaning up database and SSH tunnel...');
  try {
    try { await mdb.REST?.connection?.close(); } catch {}
    try { await mdb.INTERNAL?.connection?.close(); } catch {}
    try { await mdb.PAPERLESS?.connection?.close(); } catch {}

    if (sshServer && sshServer.close) {
      sshServer.close();
      logger.info('🛑 SSH tunnel closed');
    }
  } catch (err) {
    logger.error('⚠️ Cleanup error: ' + err.message);
  } finally {
    logger.info('✅ Cleanup complete');
  }
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

module.exports = mdb;
