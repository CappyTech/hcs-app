const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
require('dotenv').config({ path: '../.env' });
const logger = require('../loggerService');

const options = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: 24 * 60 * 60 * 1000,
    createDatabaseTable: true,
    connectionLimit: 10,
    // 🔥 This helps avoid dropped connections
    disableTouch: false,
    charset: 'utf8mb4_bin',
    schema: {
        tableName: 'sessions',
        columnNames: {
            session_id: 'session_id',
            expires: 'expires',
            data: 'data'
        }
    },
};

const sessionStore = new MySQLStore(options);

const sessionService = session({
    key: 'session_cookie_name',
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 28800000,
        sameSite: 'strict',
    }
});

sessionStore.onReady().then(() => {
    logger.info('MySQLStore ready');
}).catch(error => {
    logger.error(error);
});

sessionStore.on('error', (err) => {
    logger.error('Session store error: '+ err);
  });

  setInterval(() => {
    sessionStore.query('SELECT 1', [], (err) => {
      if (err) {
        logger.warn('⚠️ Session DB ping failed, might auto-reconnect: ' + err.message);
      }
    });
  }, 60000);
  

module.exports = sessionService;