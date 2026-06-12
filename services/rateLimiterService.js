const rateLimit = require("express-rate-limit");
const { getClientIp } = require("./ipService");
const logger = require("./loggerService");
const RateLimitMongoStore = require("./rateLimitMongoStore");
const { sanitize } = logger;

// Mongo-backed buckets: counters survive container restarts and are shared
// across replicas (the default MemoryStore is per-process). Fails open while
// MongoDB is unavailable.
const rateLimiterService = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1500, // limit each IP to 1500 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  store: new RateLimitMongoStore({ prefix: "rl:" }),
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res, next, options) => {
    const ip = getClientIp(req);
    logger.warn(`[rateLimiter] Rate limit exceeded ip=${sanitize(ip)} path=${sanitize(req.path)}`);
    res.status(options.statusCode).send(options.message);
  },
});

// Tighter per-IP limiter for the registration endpoint.
// 10 attempts per 15 minutes per IP is more than enough for legitimate use
// and significantly slows enumeration / account-farming attacks.
const registerRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many registration attempts from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  store: new RateLimitMongoStore({ prefix: "rl-reg:" }),
  keyGenerator: (req) => getClientIp(req),
  handler: (req, res, next, options) => {
    const ip = getClientIp(req);
    logger.warn(`[rateLimiter] Registration rate limit exceeded ip=${sanitize(ip)}`);
    res.status(options.statusCode).send(options.message);
  },
  skipSuccessfulRequests: true,
});

module.exports = rateLimiterService;
module.exports.registerRateLimiter = registerRateLimiter;
