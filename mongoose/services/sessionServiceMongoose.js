const session = require('express-session');
const MongoStore = require('connect-mongo');
require('dotenv').config({ path: '../.env' });
const logger = require('../../services/loggerService');
const mongoose = require('mongoose');

// Validate SESSION_SECRET early to avoid weak defaults
if (!process.env.SESSION_SECRET) {
    const msg = 'SESSION_SECRET missing. Refusing to start secure session middleware.';
    if (process.env.NODE_ENV === 'production') {
        throw new Error(msg);
    } else {
        logger.warn(msg + ' (development fallback in use, DO NOT use in production)');
        // Development ONLY fallback (random each boot => invalidates sessions on restart)
        process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
    }
}

const COOKIE_NAME = 'hms.sid';

// Create the session middleware
const sessionService = session({
    name: COOKIE_NAME, // cookie name sent to client
    key: COOKIE_NAME,  // legacy compatibility (some libs look at key)
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        client: mongoose.connection.getClient(),
        dbName: mongoose.connection.name,
    collectionName: 'sessions',
    ttl: 60 * 60 * 12, // 12 hours in seconds (store cleanup window)
        autoRemove: 'interval',
        autoRemoveInterval: 10, // in minutes
        crypto: {
            secret: process.env.SESSION_SECRET
        }
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production', // relies on trust proxy
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 8, // 8 hours
        sameSite: 'strict', // change to 'lax' if external IdP/OAuth introduced
    }
});

// Optional: log when Mongoose connection state changes
mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected: Session store ready');
});

mongoose.connection.on('error', (err) => {
    logger.error('MongoDB session error: ' + err.message);
});

module.exports = sessionService;
