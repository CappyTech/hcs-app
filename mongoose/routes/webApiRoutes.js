/**
 * Public content API consumed by hcs-web.
 *
 * Two guards, and neither is the app's usual session check:
 *
 * - `webApiLimiter` — these routes are reachable from the internet through the
 *   frp tunnel at app.heroncs.co.uk, on a domestic connection.
 * - `requireWebApiToken` — a bearer token, checked in the controller.
 *
 * The paths sit under /api/web/ for two concrete reasons. maintenanceService's
 * wantsJson() already treats /api/ as an API client, so a database outage
 * answers a JSON 503 rather than an HTML page a consumer cannot parse. And
 * requestBlocklistService 403s (and counts toward a one-hour autoban) any path
 * carrying `db`, `backup`, `database` or a .zip/.gz/.sql suffix — worth
 * remembering before renaming anything here.
 *
 * GET only. See webApiController's header for why there is no write surface.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import ctrl from '../controllers/webApiController.js';

const router = express.Router();

// Generous enough for a poll every minute from several Passenger workers, plus
// a burst of media fetches the first time a new photo is published.
const webApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: JSON.stringify({ error: 'Too many requests, try again later.' }),
});

router.get('/api/web/content', webApiLimiter, ctrl.requireWebApiToken, ctrl.getContent);
router.get('/api/web/media/:uuid', webApiLimiter, ctrl.requireWebApiToken, ctrl.getMedia);

export default router;
