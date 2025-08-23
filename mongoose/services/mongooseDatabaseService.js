'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel-ssh');
const mongoose = require('mongoose');
const logger = require('../../services/loggerService');

const basename = path.basename(__filename);
const mdb = {};
let sshServer = null;

const isTunnelEnabled = process.env.SSH_TUNNEL_ENABLED === 'true';

// Build a safe Mongo URI from a base URI and target db name
function buildMongoUri(baseUri, dbName) {
  if (!baseUri) {
    throw new Error('MONGO_URI environment variable is not defined. Please set MONGO_URI in your .env file (e.g. MONGO_URI=mongodb://user:pass@host:27017/defaultDb?authSource=admin)');
  }
  // If URI already ends with /<db>? or /<db> use it, else replace first /{something}? pattern or append
  try {
    if (/\/[^/?]+\?/.test(baseUri)) {
      return baseUri.replace(/\/([^/?]+)\?/, `/${dbName}?`);
    }
    // If ends with a slash add dbName
    if (/\/$/.test(baseUri)) return `${baseUri}${dbName}`;
    // If ends with db already, leave it
    if (new RegExp(`/${dbName}($|\?)`).test(baseUri)) return baseUri;
    // Otherwise append
    return `${baseUri.replace(/\/?$/, '/')}${dbName}`;
  } catch (e) {
    throw new Error('Failed to construct Mongo URI: ' + e.message);
  }
}

// Load models from each subfolder as a separate namespace
const loadModels = () => {
  const modelsDirectory = path.join(__dirname, '..', 'models', 'mongoose');
  const subfolders = fs.readdirSync(modelsDirectory).filter((f) => fs.statSync(path.join(modelsDirectory, f)).isDirectory());
  subfolders.forEach((folder) => {
    const folderPath = path.join(modelsDirectory, folder);
    mdb[folder] = {};
    fs.readdirSync(folderPath)
      .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
      .forEach((file) => {
        const model = require(path.join(folderPath, file));
        mdb[folder][model.modelName] = model;
        if (process.env.DEBUG === true) {
          logger.info(`Model loaded: [${folder}] ${model.modelName}`);
        }
      });
  });
};

// Helper to get DBNAME per namespace
function getDbName(namespace) {
  if (namespace === 'INTERNAL') return process.env.MONGO_DBNAME_INTERNAL;
  if (namespace === 'REST') return process.env.MONGO_DBNAME_REST;
  return process.env.MONGO_DBNAME;
}
mdb.connect = async () => {
  try {
    // Connect each namespace to its own DB
    const namespaces = ['INTERNAL', 'REST'];
    for (const ns of namespaces) {
      if (!mdb[ns]) mdb[ns] = {};
      let dbName = getDbName(ns);
      let uri;
      let connection;
      if (!isTunnelEnabled) {
  uri = buildMongoUri(process.env.MONGO_URI, dbName);
        connection = mongoose.createConnection(uri);
        await new Promise((resolve, reject) => {
          connection.once('open', resolve);
          connection.on('error', reject);
        });
        mdb[ns].connection = connection;
        // Load models for this namespace
        const modelsDirectory = path.join(__dirname, '..', 'models', 'mongoose', ns);
        if (fs.existsSync(modelsDirectory)) {
          fs.readdirSync(modelsDirectory)
            .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
            .forEach((file) => {
              const modelModule = require(path.join(modelsDirectory, file));
              // If the module exports a model, use its schema and name
              let modelName = modelModule.modelName || modelModule.model?.modelName;
              let schema = modelModule.schema || modelModule.model?.schema;
              if (!modelName || !schema) {
                // Try to extract from default export
                if (modelModule.default && modelModule.default.modelName && modelModule.default.schema) {
                  modelName = modelModule.default.modelName;
                  schema = modelModule.default.schema;
                } else {
                  logger.warn(`⚠️ Could not determine modelName/schema for ${file}`);
                  return;
                }
              }
              // Register model with the correct connection
              const model = connection.model(modelName, schema);
              mdb[ns][modelName] = model;
              if (process.env.DEBUG === true) {
                logger.info(`Model loaded: [${ns}] ${modelName}`);
              }
            });
        }
        if (process.env.DEBUG === true) {
          logger.info(`✅ Connected to MongoDB [${ns}] via MONGO_URI: ${dbName}`);
        }
      } else {
        const getPort = (await import('get-port')).default;
        const localPort = await getPort({ port: Array.from({ length: 1000 }, (_, i) => 27000 + i) });
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
          try {
            sshConfig.privateKey = fs.readFileSync(sshKeyPath);
          } catch (err) {
            logger.error(`❌ Failed to read SSH key at ${sshKeyPath}: ${err.message}`);
            throw err;
          }
        } else if (sshPass) {
          sshConfig.password = sshPass;
        } else {
          const msg = '❌ No SSH auth method provided. Set SSH_KEY_PATH or SSH_PASS in .env';
          logger.error(msg);
          throw new Error(msg);
        }
  uri = `mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@127.0.0.1:${localPort}/${dbName}?authSource=admin`;
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
        connection = mongoose.createConnection(uri);
        await new Promise((resolve, reject) => {
          connection.once('open', resolve);
          connection.on('error', reject);
        });
        mdb[ns].connection = connection;
        // Load models for this namespace
        const modelsDirectory = path.join(__dirname, '..', 'models', 'mongoose', ns);
        if (fs.existsSync(modelsDirectory)) {
          fs.readdirSync(modelsDirectory)
            .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'))
            .forEach((file) => {
              const modelModule = require(path.join(modelsDirectory, file));
              let modelName = modelModule.modelName || modelModule.model?.modelName;
              let schema = modelModule.schema || modelModule.model?.schema;
              if (!modelName || !schema) {
                if (modelModule.default && modelModule.default.modelName && modelModule.default.schema) {
                  modelName = modelModule.default.modelName;
                  schema = modelModule.default.schema;
                } else {
                  logger.warn(`⚠️ Could not determine modelName/schema for ${file}`);
                  return;
                }
              }
              const model = connection.model(modelName, schema);
              mdb[ns][modelName] = model;
              if (process.env.DEBUG === true) {
                logger.info(`Model loaded: [${ns}] ${modelName}`);
              }
            });
        }
        if (process.env.DEBUG === true) {
          logger.info(`✅ Connected to MongoDB [${ns}] via SSH tunnel: ${dbName}`);
        }
      }
    }
    // Post-connection validation
    if (!mdb.INTERNAL || !mdb.INTERNAL.connection) {
      logger.error('❌ INTERNAL connection is undefined after connect()');
      throw new Error('INTERNAL connection is undefined after connect()');
    } else {
      logger.info('✅ INTERNAL connection is valid after connect()');
    }
    return mdb;
  } catch (err) {
    logger.error('❌ Database connection setup failed: ' + err.message);
    throw err;
  }
};

const cleanup = async () => {
  logger.info('🧹 Cleaning up database and SSH tunnel...');
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
      logger.info('✅ Mongoose disconnected');
    } else {
      logger.info('ℹ️ Mongoose was not connected');
    }

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
