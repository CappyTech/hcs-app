'use strict';

require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const logger = require('./loggerService');
const basename = path.basename(__filename);
const kf = {};

// Initialize Sequelize instance
const sequelize = new Sequelize(
    process.env.KF_DB,
    process.env.KF_USER,
    process.env.KF_PASS,
    {
        host: process.env.DB_HOST,
        dialect: 'mysql',
        logging: false, // Set to console.log for query debugging
    }
);

// Authenticate Sequelize
sequelize
    .authenticate()
    .then(() => {
        if (process.env.DEBUG) {
            //logger.info('kashflow Database connection has been established successfully.');
        }
    })
    .catch((error) => {
        logger.error('Unable to connect to the kashflow database: ' + error.message);
        logger.error('Details:', error);
        process.exit(1);
    });

// Step 1: Dynamically load all models from the models directory
const modelsDirectory = path.join(__dirname, '../models/kf');

// Load model files
const modelFiles = fs
    .readdirSync(modelsDirectory)
    .filter((file) => file.indexOf('.') !== 0 && file !== basename && file.slice(-3) === '.js');

// Define models (Step 1)
modelFiles.forEach((file) => {
    const model = require(path.join(modelsDirectory, file))(sequelize, Sequelize.DataTypes);
    kf[model.name] = model;
});

// Step 2: Invoke associate methods for models
Object.keys(kf).forEach((modelName) => {
    if (kf[modelName].associate) {
        kf[modelName].associate(kf);
        logger.info(`Associations defined for ${modelName}`);
    }
});

// Log model names and associations
logger.info('Models Loaded:', Object.keys(kf));

Object.keys(kf).forEach((modelName) => {
    logger.info(`Associations for ${modelName}:`, kf[modelName].associations);
});

// Synchronize with logging (only in development)
if (process.env.NODE_ENV === 'development') {
    sequelize.sync({ alter: false })
        .then(() => logger.info('All models were synchronized successfully.'))
        .catch((error) => {
            logger.error('Error synchronizing database:' + error.message);
            process.exit(1);
        });
}

// Export the database object with Sequelize instance and models
kf.sequelize = sequelize;
kf.Sequelize = Sequelize;

module.exports = kf;
