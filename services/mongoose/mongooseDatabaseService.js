'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel-ssh');
const mongoose = require('mongoose');
const logger = require('../loggerService');

const basename = path.basename(__filename);
const mdb = {};

const isTunnelEnabled = process.env.SSH_TUNNEL_ENABLED === 'true';

const loadModels = () => {
  const modelsDirectory = path.join(__dirname, '../../models/mongoose');
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

mdb.connect = () => {
  return new Promise((resolve, reject) => {
    if (!isTunnelEnabled) {
      // Direct MongoDB connection
      const uri = process.env.MONGO_URI;
      mongoose.connect(uri, {
      }).then(() => {
        if (process.env.DEBUG) {
          logger.info('✅ Connected to MongoDB via MONGO_URI');
        }
        loadModels();
        resolve(mdb);
      }).catch(err => {
        logger.error('❌ MongoDB connection error: ' + err.message);
        reject(err);
      });

    } else {
      // SSH tunnel setup
      const sshConfig = {
        username: process.env.SSH_USER,
        host: process.env.SSH_HOST,
        port: parseInt(process.env.SSH_PORT || '22'),
        dstHost: process.env.SSH_REMOTE_HOST || '127.0.0.1',
        dstPort: parseInt(process.env.SSH_REMOTE_PORT || '27017'),
        localHost: '127.0.0.1',
        localPort: parseInt(process.env.SSH_LOCAL_PORT || '27000'),
        keepAlive: true,
      };

      const sshKeyPath = process.env.SSH_KEY_PATH?.trim();
      const sshPass = process.env.SSH_PASS?.trim();

      if (sshKeyPath) {
        try {
          sshConfig.privateKey = fs.readFileSync(sshKeyPath);
        } catch (err) {
          logger.error(`❌ Failed to read SSH key at ${sshKeyPath}: ${err.message}`);
          return reject(err);
        }
      } else if (sshPass) {
        sshConfig.password = sshPass;
      } else {
        const msg = '❌ No SSH auth method provided. Set SSH_KEY_PATH or SSH_PASS in .env';
        logger.error(msg);
        return reject(new Error(msg));
      }

      const uri = `mongodb://127.0.0.1:${sshConfig.localPort}/${process.env.MONGO_DBNAME}`;

      tunnel(sshConfig, (err, server) => {
        if (err) {
          logger.error('❌ SSH tunnel error: ' + err.message);
          return reject(err);
        }

        mongoose.connect(uri, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
        }).then(() => {
          if (process.env.DEBUG) {
            logger.info('✅ Connected to MongoDB via SSH tunnel');
          }
          loadModels();
          resolve(mdb);
        }).catch(mongoErr => {
          logger.error('❌ MongoDB (via SSH) connection error: ' + mongoErr.message);
          reject(mongoErr);
        });
      });
    }
  });
};

module.exports = mdb;
