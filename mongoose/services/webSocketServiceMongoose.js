const sharedSession = require('express-socket.io-session');
const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');
const { setSocketInstance } = require('../../services/loggerService');

function setupWebSocket(io, sessionService) {
  setSocketInstance(io);

  io.use(sharedSession(sessionService, { autoSave: true }));

  io.use(async (socket, next) => {
    const session = socket.handshake.session;
    if (!session?.user?.id) return next(new Error('Not authenticated'));

    const user = await mdb.user.findById(session.user.id);
    if (!user) return next(new Error('User not found'));

    socket.user = user;
    return next();
  });

  io.on('connection', (socket) => {
    const user = socket.user;

    if (user.role !== 'admin') {
      socket.disconnect(true);
      return;
    }

    socket.join('admins');
    socket.emit('logs:init', { message: 'Connected to log stream' });

    socket.on('disconnect', () => {
      logger.info(`🔌 Socket disconnected: ${user.username}`);
    });
  });
}

module.exports = {
  setupWebSocket
};
