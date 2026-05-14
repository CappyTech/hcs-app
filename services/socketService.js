// services/socketService.js
const { Server } = require("socket.io");
const logger = require('./loggerService');

let io = null;

function initSocket(server) {
  if (io) {
    logger.warn('[socketService] Socket.IO already initialized, returning existing instance');
    return io; // Prevent double init
  }
  logger.info('[socketService] Initializing Socket.IO...');
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    logger.debug(`[socketService] Socket connected: ${socket.id}`);

    socket.on("disconnect", () => {
      logger.debug(`[socketService] Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

function getIo() {
  if (!io) throw new Error("Socket.io not initialized!");
  return io;
}

module.exports = { initSocket, getIo };
