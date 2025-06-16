'use strict';

require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const logger = require('../loggerService');
const basename = path.basename(__filename);
const db = {};

// Initialize Sequelize instance
const sequelize = new Sequelize(
    process.env.DB_DATABASE,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
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
            logger.info('MySQL Database connection has been established successfully.');
        }
    })
    .catch((error) => {
        logger.error('Unable to connect to the MySQL database: ' + error.message);
        logger.error('Details:', error);
        process.exit(1);
    });

// Step 1: Dynamically load all models from the models directory
const modelsDirectory = path.join(__dirname, '../../models/sequelize');

// Load model files
const modelFiles = fs
    .readdirSync(modelsDirectory)
    .filter((file) => {
        const isJsFile = file.endsWith('.js');
        const isNotSelf = file !== basename;
        // const isNotDeprecated = !file.includes('-replacedby') && !file.includes('-notused') && !file.includes('-notimplemented');
        return isJsFile && isNotSelf;
    });

// Define models (Step 1)
modelFiles.forEach((file) => {
    const model = require(path.join(modelsDirectory, file))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
});

// Step 2: Invoke associate methods for models
Object.keys(db).forEach((modelName) => {
    if (db[modelName].associate) {
        db[modelName].associate(db);
        logger.debug(`Associations defined for ${modelName}`);
    }
});

// Log model names and associations
logger.debug('Models Loaded:', Object.keys(db));

Object.keys(db).forEach((modelName) => {
    logger.debug(`Associations for ${modelName}: ${db[modelName].associations}`);
});

// Export the database object with Sequelize instance and models
db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
