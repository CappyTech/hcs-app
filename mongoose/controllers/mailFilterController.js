import path from 'path';
import log from '../services/mailFilterLogService.js';

/**
 * HTTP layer for the inbound mail filtering log. Thin by design: parse and
 * clamp the query string, delegate to mailFilterLogService, render.
 *
 * Auth lives in mailRoutes.js, not here.
 *
 * There is no database call anywhere in this file and no mdb.connect(): the
 * data is NDJSON on a read-only bind mount, owned by the mailsiem collector on
 * the host. See mailFilterLogService.js for why it is not in Mongo.
 *
 * Every handler is a GET. There is no write path in this module — not a
 * disabled one, an absent one.
 */

const VIEW = (name) => path.join('tailwindcss', 'mail', name);

export const getIndex = async (req, res, next) => {
  try {
    const q = log.normaliseQuery(req.query.q);
    const days = log.normaliseDays(req.query.days);
    const blockedOnly = req.query.blocked === '1';

    // The summary is rendered on every load, so it uses its own narrower
    // window and is not widened by the search's `days`. Searching 90 days is a
    // deliberate act; recomputing 90 days of counters on every page view is not.
    const summary = await log.summary({});

    // A bare page load must not scan anything: with no search term and no
    // filter there is nothing to narrow by, and returning "the most recent
    // hundred" would invite reading it as a complete list.
    const results = (q || blockedOnly)
      ? await log.search({ q, days, blockedOnly, limit: 200 })
      : null;

    res.render(VIEW('index'), {
      title: 'Mail Filtering Log',
      status: log.status(),
      summary,
      results,
      q,
      days,
      blockedOnly,
      maxDays: log.MAX_DAYS,
    });
  } catch (err) { next(err); }
};

/**
 * Everything recorded against one filtering id. A message with several
 * recipients is several decisions sharing that id, so this page is the only
 * place the fan-out is visible as one thing.
 */
export const getMessage = async (req, res, next) => {
  try {
    const id = log.normaliseQuery(req.params.id);
    const found = await log.byId(id);
    res.render(VIEW('message'), {
      title: `Message ${id}`,
      id,
      status: log.status(),
      rows: found.rows,
      mounted: found.mounted,
    });
  } catch (err) { next(err); }
};

export default { getIndex, getMessage };
