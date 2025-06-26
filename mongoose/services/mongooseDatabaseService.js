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

const loadModels = () => {
  const modelsDirectory = path.join(__dirname, '..', 'models', 'mongoose');
  fs.readdirSync(modelsDirectory)
    .filter((file) =>
      file.endsWith('.js') &&
      !file.endsWith('.test.js') &&
      file !== basename
    )
    .forEach((file) => {
      const model = require(path.join(modelsDirectory, file));
      mdb[model.modelName] = model;
      if (process.env.DEBUG) {
        logger.info(`Model loaded: ${model.modelName}`);
      }
    });
};

mdb.connect = async () => {
  try {
    if (!isTunnelEnabled) {
      const uri = process.env.MONGO_URI;
      await mongoose.connect(uri);
      if (process.env.DEBUG) {
        logger.info('✅ Connected to MongoDB via MONGO_URI');
      }
      loadModels();
      return mdb;
    }

    // ✅ Import get-port dynamically inside the async function
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

    const mongoURI = `mongodb://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@127.0.0.1:${localPort}/${process.env.MONGO_DBNAME}?authSource=admin`;

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

    await mongoose.connect(mongoURI);
    if (process.env.DEBUG) {
      logger.info('✅ Connected to MongoDB via SSH tunnel');
    }
    loadModels();
    return mdb;
  } catch (err) {
    logger.error('❌ Database connection setup failed: ' + err.message);
    throw err;
  }
};

const cleanup = async () => {
  logger.info('🧹 Cleaning up database and SSH tunnel...');
  try {
    await mongoose.disconnect();
    if (sshServer && sshServer.close) {
      sshServer.close();
      logger.info('🛑 SSH tunnel closed');
    }
  } catch (err) {
    logger.error('⚠️ Cleanup error: ' + err.message);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

module.exports = mdb;
