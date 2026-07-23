import fs from 'fs';
import path from 'path';
import { createLogger, format, transports } from 'winston';
import Transport from 'winston-transport';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
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
      }
    });

    callback();
  }
}

// Format for console output
const consoleFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const isTest = process.env.NODE_ENV === 'test';

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
    ...(!isTest ? [new transports.File({
      filename: logFile,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: combine(timestamp(), json()),
    })] : []),
    new WebSocketTransport(),
  ],
});

// Sanitize user-controlled strings before interpolating into log messages.
// Strips newlines and control characters to prevent log injection attacks.
function sanitize(value, maxLen = 200) {
  if (value == null) return 'null';
  return String(value)
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ')
    .slice(0, maxLen);
}

// CJS attached these as properties of the logger; keep that shape for
// consumers that access them via the default export.
logger.setSocketInstance = setSocketInstance;
logger.sanitize = sanitize;

export default logger;
export { setSocketInstance };
export { sanitize };
