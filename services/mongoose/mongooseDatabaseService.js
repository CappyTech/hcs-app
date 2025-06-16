'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const logger = require('../loggerService');
const basename = path.basename(__filename);
const mdb = {};

// Connect to MongoDB
const mongoURI = process.env.MONGO_URI;
mongoose
    .connect(mongoURI, {
        
    })
    .then(() => {
        if (process.env.DEBUG) {
            //logger.info('Mongo Database connection has been established successfully.');
        }
    })
    .catch((error) => {
        logger.error('Unable to connect to the Mongo database: '+ error.message);
        logger.error('Details:'+ error);
    });

// Dynamically load all models from the models directory
const modelsDirectory = path.join(__dirname, '../../models/mongoose');
fs.readdirSync(modelsDirectory)
    .filter((file) => {
        return (
            file.indexOf('.') !== 0 &&
            file !== basename &&
            file.slice(-3) === '.js' &&
            file.indexOf('.test.js') === -1
        );
    })
    .forEach((file) => {
        const model = require(path.join(modelsDirectory, file));
        mdb[model.modelName] = model;
        //logger.info(`Mongoose Model Loaded: ${model.modelName}`);
    });

// Export the database object with models
module.exports = mdb;
