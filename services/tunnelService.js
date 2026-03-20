// tunnelConnect.js
const tunnel = require("tunnel-ssh");
const mongoose = require("mongoose");
require("dotenv").config();

const sshPass = process.env.SSH_PASS?.trim();

if (!sshPass) {
  throw new Error(
    "❌ SSH_PASS must be defined in your .env file for password-based SSH authentication",
  );
}

const sshConfig = {
  username: process.env.SSH_USER,
  host: process.env.SSH_HOST,
  port: Number(process.env.SSH_PORT || 22),
  dstHost: process.env.SSH_REMOTE_HOST || "127.0.0.1",
  dstPort: Number(process.env.SSH_REMOTE_PORT || 27017),
  localHost: "127.0.0.1",
  localPort: Number(process.env.SSH_LOCAL_PORT || 27000),
  keepAlive: true,
  password: sshPass,
};

const mongoURI = `mongodb://127.0.0.1:${sshConfig.localPort}/${process.env.MONGO_DBNAME}`;

let tunnelServer = null;

const startTunnelAndConnect = () => {
  return new Promise((resolve, reject) => {
    tunnel(sshConfig, (error, server) => {
      if (error)
        return reject(new Error("❌ SSH tunnel error: " + error.message));

      tunnelServer = server;

      // Guard against unhandled 'error' events (e.g., ECONNRESET when client disconnects)
      server.on("error", (err) => {
        const code = err?.code || err?.errno;
        const level = err?.level;
        if (
          code === "ECONNRESET" ||
          code === "EPIPE" ||
          level === "client-socket"
        ) {
          console.warn(
            "⚠️ SSH tunnel socket reset/pipe closed (ignored):",
            code || level,
          );
          return; // swallow expected client socket resets
        }
        console.error("❌ SSH tunnel server error:", err);
      });

      server.on("close", () => {
        console.log("🧵 SSH tunnel server closed");
      });

      console.log(
        `✅ SSH tunnel established → ${sshConfig.localHost}:${sshConfig.localPort}`,
      );

      mongoose
        .connect(mongoURI, {
          useNewUrlParser: true,
          useUnifiedTopology: true,
        })
        .then(() => {
          console.log(`✅ Mongoose connected → ${mongoURI}`);
          resolve();
        })
        .catch((err) => {
          reject(new Error("❌ Mongoose error: " + err.message));
        });
    });
  });
};

// Optional: graceful shutdown helpers
const stopTunnelAndDisconnect = async () => {
  try {
    await mongoose.connection.close(false);
  } catch (e) {
    // ignore
  }
  if (tunnelServer) {
    try {
      tunnelServer.close();
    } catch (e) {
      /* ignore */
    }
    tunnelServer = null;
  }
};

process.on("SIGINT", async () => {
  console.log("🧹 Cleaning up database and SSH tunnel (SIGINT)");
  await stopTunnelAndDisconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("🧹 Cleaning up database and SSH tunnel (SIGTERM)");
  await stopTunnelAndDisconnect();
  process.exit(0);
});

module.exports = { startTunnelAndConnect, stopTunnelAndDisconnect };
