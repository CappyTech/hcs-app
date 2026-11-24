import express from 'express';

/**
 * Session time limit (WCAG 2.2.1 Timing Adjustable).
 *
 * The session cookie lasts 8 hours (sessionService.js). That is shorter than
 * the 20 hours WCAG exempts, so people must be warned before it runs out and be
 * able to extend it: otherwise a half-filled form is lost when the next save
 * lands on the sign-in page.
 *
 * - `exposeSessionExpiry` puts the expiry time on res.locals; layout.ejs writes
 *   it into a meta tag that public/js/session-timeout.js reads.
 * - POST /session/extend marks the session as changed, so express-session
 *   re-issues the cookie with a fresh 8 hours, and returns the new expiry.
 */

export function sessionExpiresAt(req) {
  const expires = req.session?.cookie?.expires;
  if (!expires) return null;
  const at = new Date(expires).getTime();
  return Number.isFinite(at) ? at : null;
}

export function exposeSessionExpiry(req, res, next) {
  res.locals.sessionExpiresAt = req.user ? sessionExpiresAt(req) : null;
  next();
}

const router = express.Router();

router.post('/session/extend', (req, res) => {
  if (!req.user || !req.session) return res.status(401).json({ ok: false });
  req.session.extendedAt = Date.now();
  req.session.cookie.maxAge = req.session.cookie.originalMaxAge || 1000 * 60 * 60 * 8;
  req.session.save((err) => {
    if (err) return res.status(500).json({ ok: false });
    res.json({ ok: true, expiresAt: sessionExpiresAt(req) });
  });
});

export default router;
