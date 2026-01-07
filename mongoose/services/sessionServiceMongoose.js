const session = require('express-session');
const MongoStore = require('connect-mongo');
require('dotenv').config({ path: '../.env' });
const logger = require('../../services/loggerService');

const COOKIE_NAME = 'hms.sid';

module.exports = function createSessionService(mongoClient) {
    if (!process.env.SESSION_SECRET) {
        const msg = 'SESSION_SECRET missing. Refusing to start secure session middleware.';
        if (process.env.NODE_ENV === 'production') {
            throw new Error(msg);
        } else {
            logger.warn(msg + ' (development fallback in use, DO NOT use in production)');
            process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
        }
    }
        const cookieSecure = (process.env.COOKIE_SECURE || '').toLowerCase() === 'true'
            ? true
            : (process.env.COOKIE_SECURE || '').toLowerCase() === 'false'
                ? false
                : process.env.NODE_ENV === 'production';

        return session({
        name: COOKIE_NAME,
        key: COOKIE_NAME,
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        store: MongoStore.create({
            client: mongoClient,
            dbName: process.env.MONGO_DBNAME_INTERNAL,
            collectionName: 'sessions',
            ttl: 60 * 60 * 12,
            autoRemove: 'interval',
            autoRemoveInterval: 10,
            crypto: { secret: process.env.SESSION_SECRET }
        }),
        cookie: {
            secure: cookieSecure,
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 8,
            // Lax improves post-redirect flows while maintaining CSRF protections
            sameSite: 'lax',
        }
    });
};
