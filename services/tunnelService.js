// tunnelConnect.js
const tunnel = require('tunnel-ssh');
const mongoose = require('mongoose');
require('dotenv').config();

const sshPass = process.env.SSH_PASS?.trim();

if (!sshPass) {
  throw new Error('❌ SSH_PASS must be defined in your .env file for password-based SSH authentication');
}

const sshConfig = {
  username: process.env.SSH_USER,
  host: process.env.SSH_HOST,
  port: Number(process.env.SSH_PORT || 22),
  dstHost: process.env.SSH_REMOTE_HOST || '127.0.0.1',
  dstPort: Number(process.env.SSH_REMOTE_PORT || 27017),
  localHost: '127.0.0.1',
  localPort: Number(process.env.SSH_LOCAL_PORT || 27000),
  keepAlive: true,
  password: sshPass,
};

const mongoURI = `mongodb://127.0.0.1:${sshConfig.localPort}/${process.env.MONGO_DBNAME}`;

const startTunnelAndConnect = () => {
  return new Promise((resolve, reject) => {
    tunnel(sshConfig, (error, server) => {
      if (error) return reject(new Error('❌ SSH tunnel error: ' + error.message));

      console.log(`✅ SSH tunnel established → ${sshConfig.localHost}:${sshConfig.localPort}`);

      mongoose.connect(mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }).then(() => {
        console.log(`✅ Mongoose connected → ${mongoURI}`);
        resolve();
      }).catch(err => {
        reject(new Error('❌ Mongoose error: ' + err.message));
      });
    });
  });
};

module.exports = { startTunnelAndConnect };
