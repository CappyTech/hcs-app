const { Server } = require('socket.io');
const sharedSession = require('express-socket.io-session');
const authService = require('../../services/authService');
const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');
const { setSocketInstance } = require('../../services/loggerService'); // ⬅️ import it

let io;

function setupWebSocket(server, sessionService) {
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    }
  });

  setSocketInstance(io); // ✅ Pass reference to loggerService

  io.use(sharedSession(sessionService, { autoSave: true }));

  io.use(async (socket, next) => {
    const session = socket.handshake.session;
    logger.debug('WebSocket: Session data -> ' + JSON.stringify(session));
    if (!session?.user?.id) return next(new Error('Not authenticated'));

    const user = await mdb.user.findById(session.user.id);
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    logger.debug(`WebSocket: Authenticated as ${user.username} (${user.role})`);
    return next();
  });

  io.on('connection', (socket) => {
    const user = socket.user;

    logger.debug(`Connected: ${socket.id}`);
    logger.debug('Current rooms: ' + JSON.stringify(Array.from(socket.rooms)));

    if (!user.role === 'admin') {
      socket.disconnect(true);
      return;
    }

    logger.info(`✅ WebSocket connected: ${user.username} (${user.role})`);

    if (user.role === 'admin') {
      socket.join('admins');
      logger.debug(`Joined 'admins' room: ${socket.id}`);
    }

    socket.emit('logs:init', { message: 'Connected to log stream' });

    socket.on('disconnect', () => {
      logger.info(`🔌 Socket disconnected: ${user.username}`);
    });
  });
}

function wrapSocketToReq(socket) {
  return { user: socket.user };
}

module.exports = {
  setupWebSocket
};
