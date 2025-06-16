'use strict';

require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const logger = require('../loggerService');
const basename = path.basename(__filename);
const { isMainThread } = require('worker_threads');

const kf = {};

// Default (singleton) Sequelize instance
const sequelize = new Sequelize(
  process.env.KF_DB,
  process.env.KF_USER,
  process.env.KF_PASS,
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false, // Set to console.log for query debugging
    pool: {
      max: 5,        // Maximum active connections
      min: 0,        // Minimum idle
      acquire: 30000, // Max time to get a connection before throwing error
      idle: 10000     // Max idle time before releasing connection
    }
  }
);

// Authenticate default instance
sequelize
  .authenticate()
  .then(() => {
    if (process.env.DEBUG) {
      logger.info('kashflow Database connection has been established successfully.');
    }
  })
  .catch((error) => {
    logger.error('Unable to connect to the kashflow database: ' + error.message);
    logger.error('Details:', error);
    process.exit(1);
  });

// Load models for default instance
const modelsDirectory = path.join(__dirname, '../models/kf');

const modelFiles = fs
  .readdirSync(modelsDirectory)
  .filter((file) => file.indexOf('.') !== 0 && file !== basename && file.slice(-3) === '.js');

modelFiles.forEach((file) => {
  const model = require(path.join(modelsDirectory, file))(sequelize, Sequelize.DataTypes);
  kf[model.name] = model;
});

Object.keys(kf).forEach((modelName) => {
  if (kf[modelName].associate) {
    kf[modelName].associate(kf);
  }
});

// Sync only if main thread in development
if (isMainThread && process.env.NODE_ENV === 'development') {
  sequelize.sync({ alter: false })
    .then(() => logger.info('All models were synchronized successfully.'))
    .catch((error) => {
      logger.error('Error synchronizing database:' + error.message);
      process.exit(1);
    });
}

kf.sequelize = sequelize;
kf.Sequelize = Sequelize;

// 🆕 Function to create a new isolated DB connection + model set
function createDbConnection() {
  const sequelizeInstance = new Sequelize(
    process.env.KF_DB,
    process.env.KF_USER,
    process.env.KF_PASS,
    {
      host: process.env.DB_HOST,
      dialect: 'mysql',
      logging: false,
    }
  );

  const db = {};

  const files = fs
    .readdirSync(modelsDirectory)
    .filter((file) => file.indexOf('.') !== 0 && file !== basename && file.slice(-3) === '.js');

  files.forEach((file) => {
    const model = require(path.join(modelsDirectory, file))(sequelizeInstance, Sequelize.DataTypes);
    db[model.name] = model;
  });

  Object.keys(db).forEach((modelName) => {
    if (db[modelName].associate) {
      db[modelName].associate(db);
    }
  });

  db.sequelize = sequelizeInstance;
  db.Sequelize = Sequelize;

  if (!isMainThread) {
    logger.debug('[worker thread] DB connection established (no sync).');
  }

  return db;
}

module.exports = {
  ...kf,
  createDbConnection,
};
