const fs = require("fs");
const path = require("path");
const { createLogger, format, transports } = require("winston");
const Transport = require("winston-transport");
const { combine, timestamp, printf, colorize, json } = format;

let io = null;

function setSocketInstance(socketInstance) {
  io = socketInstance;
}

// Ensure log directory and file exist
const logDir = path.join(__dirname, "../logs");
const logFile = path.join(logDir, "app.json.log");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, "", { flag: "wx" }); // Create empty file if not exists
}

// Custom WebSocket transport
class WebSocketTransport extends Transport {
  constructor(opts = {}) {
    super(opts);
  }

  log(info, callback) {
    setImmediate(() => {
      if (io) {
        io.to("admins").emit("logs:update", {
          level: info.level,
          message: info.message,
          timestamp: info.timestamp || new Date().toISOString(),
          ...(info.user && { user: info.user }),
          ...(info.route && { route: info.route }),
        });
      } else {
        console.log("⚠️ io is null, log not emitted");
      }
    });

    callback();
  }
}

// Format for console output
const consoleFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const logger = createLogger({
  level: "debug",
  format: combine(timestamp({ format: "DD-MM-YYYY HH:mm:ss" }), json()),
  transports: [
    new transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: "DD-MM-YYYY HH:mm:ss" }),
        consoleFormat,
      ),
    }),
    new transports.File({
      filename: logFile,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: combine(timestamp(), json()),
    }),
    new WebSocketTransport(),
  ],
});

module.exports = logger;
module.exports.setSocketInstance = setSocketInstance;
