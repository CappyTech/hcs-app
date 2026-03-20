// services/socketService.js
const { Server } = require("socket.io");

let io = null;

function initSocket(server) {
  if (io) {
    console.warn(
      "[DUPE CHECK] ⚠️ Socket.IO already initialized, returning existing instance",
    );
    return io; // Prevent double init
  }
  console.log("[DUPE CHECK] ✅ Initializing Socket.IO...");
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

function getIo() {
  if (!io) throw new Error("Socket.io not initialized!");
  return io;
}

module.exports = { initSocket, getIo };
