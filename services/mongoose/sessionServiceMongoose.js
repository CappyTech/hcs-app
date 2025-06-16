const session = require('express-session');
const MongoStore = require('connect-mongo');
require('dotenv').config({ path: '../.env' });
const logger = require('../loggerService');
const mongoose = require('mongoose');

const sessionService = session({
    key: 'session_cookie_name',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        client: mongoose.connection.getClient(),
        dbName: mongoose.connection.name,
        collectionName: 'sessions',
        ttl: 60 * 60 * 24, // 1 day
        autoRemove: 'interval',
        autoRemoveInterval: 10, // Minutes
        crypto: {
            secret: process.env.SESSION_SECRET
        }
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 28800000, // 8 hours
        sameSite: 'strict',
    }
});

mongoose.connection.on('connected', () => {
    //logger.info('MongoDB connected: Session store ready');
});

mongoose.connection.on('error', (err) => {
    logger.error('MongoDB session error: ' + err.message);
});

module.exports = sessionService;
