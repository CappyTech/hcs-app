import { AsyncLocalStorage } from 'async_hooks';

// Carries the acting user + request context for the lifetime of a request so the
// Mongoose audit plugin can attribute DB writes without threading `req` through
// every service and model call.
const als = new AsyncLocalStorage();

/**
 * Express middleware — binds the current request's actor/context to async-local
 * storage. Mount it after the session + auth middleware so `req.session.user`
 * is populated.
 */
function middleware(req, res, next) {
  const u = req.session && req.session.user;
  const ctx = {
    actorId:    u && u.id ? u.id : null,
    actorName:  u ? (u.username || u.name || '') : '',
    actorEmail: u ? (u.email || '') : '',
    ip:         req.ip || (req.connection && req.connection.remoteAddress) || '',
    method:     req.method || '',
    route:      req.originalUrl || req.url || '',
  };
  als.run(ctx, () => next());
}

/** Returns the current context, or null when outside a request (cron/jobs). */
function get() {
  return als.getStore() || null;
}

/** Runs `fn` within an explicit context — use for background jobs/cron. */
function runAs(ctx, fn) {
  return als.run(ctx, fn);
}

export default { middleware, get, runAs };
