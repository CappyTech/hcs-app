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

    // This is a log first and a search second, so a bare page load shows the
    // most recent decisions rather than an empty page with a search box. The
    // earlier design refused to list anything without a filter, on the grounds
    // that a partial list invites being read as a complete one; the answer to
    // that is to label it honestly, not to withhold it.
    //
    // It stays cheap because the reader takes each file's newest rows and stops
    // once it has a page: every remaining day file is older, so a browse
    // normally reads one file however wide the window is.
    const limit = log.normaliseLimit(req.query.limit);
    const results = await log.search({ q, days, blockedOnly, limit });

    res.render(VIEW('index'), {
      title: 'Mail Filtering Log',
      status: log.status(),
      summary,
      results,
      q,
      days,
      blockedOnly,
      limit,
      limitOptions: log.LIMIT_OPTIONS,
      filtered: Boolean(q || blockedOnly),
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
