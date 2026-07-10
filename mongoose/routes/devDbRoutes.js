'use strict';

// ── Dev-only MongoDB inspector API ──────────────────────────────────────────
// Mounted at /admin/db by app.js ONLY when DEV_DB_ADMIN=true and
// NODE_ENV !== 'production'. It is mounted BEFORE the session/auth stack so
// it is reachable without a login; as compensation every request must come
// from loopback. Never enable DEV_DB_ADMIN in a deployed environment.
//
// Reads and writes go through the native driver (model.collection) to avoid
// mongoose query casting / strict-mode surprises. Writes bypass the audit
// plugin — this is a local debugging tool, not an application surface.
//
// JSON bodies and query-string JSON support {"$date":"ISO"} markers, revived
// to real Date objects so date-field filters match.

const express = require('express');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

const router = express.Router();
router.use(express.json({ limit: '2mb' }));

const NAMESPACES = ['REST', 'INTERNAL', 'PAPERLESS'];
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 20;

// Loopback-only guard
router.use((req, res, next) => {
  const ra = req.socket?.remoteAddress || '';
  const isLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  if (!isLocal) {
    logger.warn(`[devDb] Rejected non-loopback request from ${ra}`);
    return res.status(403).json({ error: 'forbidden: loopback only' });
  }
  next();
});

// Revive {"$date":"..."} markers into Date objects, recursively.
const reviveDates = (v) => {
  if (Array.isArray(v)) return v.map(reviveDates);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$date') {
      const d = new Date(v.$date);
      return isNaN(d.getTime()) ? v : d;
    }
    const out = {};
    for (const k of keys) out[k] = reviveDates(v[k]);
    return out;
  }
  return v;
};

const parseJsonParam = (raw, fallback) => {
  if (raw == null || raw === '') return fallback;
  return reviveDates(JSON.parse(raw));
};

// Resolve :ns/:model to a mongoose model; respond with the error itself.
const resolveModel = (req, res) => {
  const { ns, model } = req.params;
  if (!NAMESPACES.includes(ns)) {
    res.status(400).json({ error: `unknown namespace '${ns}'`, namespaces: NAMESPACES });
    return null;
  }
  const bucket = mdb[ns] || {};
  const m = bucket[model];
  if (!m || typeof m.find !== 'function') {
    const models = Object.keys(bucket).filter((k) => k !== 'connection');
    res.status(404).json({ error: `unknown model '${model}' in ${ns}`, models });
    return null;
  }
  return m;
};

const clampLimit = (raw) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
};

// GET /admin/db — namespaces, models and document counts
router.get('/', async (req, res) => {
  try {
    const out = {};
    for (const ns of NAMESPACES) {
      const bucket = mdb[ns] || {};
      const models = Object.keys(bucket).filter((k) => k !== 'connection');
      out[ns] = {};
      for (const name of models) {
        try {
          out[ns][name] = await bucket[name].estimatedDocumentCount();
        } catch (e) {
          out[ns][name] = `error: ${e.message}`;
        }
      }
    }
    res.json({ connected: !!mdb.REST?.connection, namespaces: out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/db/:ns/:model — query via query-string
//   ?filter={}&projection={}&sort={}&limit=20&skip=0
router.get('/:ns/:model', async (req, res) => {
  const model = resolveModel(req, res);
  if (!model) return;
  try {
    const filter = parseJsonParam(req.query.filter, {});
    const projection = parseJsonParam(req.query.projection, undefined);
    const sort = parseJsonParam(req.query.sort, undefined);
    const limit = clampLimit(req.query.limit);
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    let cursor = model.collection.find(filter);
    if (projection) cursor = cursor.project(projection);
    if (sort) cursor = cursor.sort(sort);
    const [docs, total] = await Promise.all([
      cursor.skip(skip).limit(limit).toArray(),
      model.collection.countDocuments(filter),
    ]);
    res.json({ total, skip, limit, count: docs.length, docs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/db/:ns/:model/query — same as GET but filter/sort in the body
//   { filter, projection, sort, limit, skip }
router.post('/:ns/:model/query', async (req, res) => {
  const model = resolveModel(req, res);
  if (!model) return;
  try {
    const body = reviveDates(req.body || {});
    const filter = body.filter || {};
    const limit = clampLimit(body.limit);
    const skip = Math.max(0, parseInt(body.skip, 10) || 0);
    let cursor = model.collection.find(filter);
    if (body.projection) cursor = cursor.project(body.projection);
    if (body.sort) cursor = cursor.sort(body.sort);
    const [docs, total] = await Promise.all([
      cursor.skip(skip).limit(limit).toArray(),
      model.collection.countDocuments(filter),
    ]);
    res.json({ total, skip, limit, count: docs.length, docs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/db/:ns/:model/aggregate — { pipeline: [...] }
router.post('/:ns/:model/aggregate', async (req, res) => {
  const model = resolveModel(req, res);
  if (!model) return;
  try {
    const pipeline = reviveDates(req.body?.pipeline);
    if (!Array.isArray(pipeline)) {
      return res.status(400).json({ error: 'body must be { pipeline: [...] }' });
    }
    // $out/$merge would write to arbitrary collections — refuse them.
    const banned = pipeline.find((st) => st && (st.$out !== undefined || st.$merge !== undefined));
    if (banned) return res.status(400).json({ error: '$out/$merge stages are not allowed' });
    const docs = await model.collection.aggregate(pipeline).toArray();
    res.json({ count: docs.length, docs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/db/:ns/:model/update — { filter, update, multi=false, upsert=false }
router.post('/:ns/:model/update', async (req, res) => {
  const model = resolveModel(req, res);
  if (!model) return;
  try {
    const body = reviveDates(req.body || {});
    const { filter, update } = body;
    if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) {
      return res.status(400).json({ error: 'a non-empty filter is required' });
    }
    if (!update || typeof update !== 'object' || Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'a non-empty update is required' });
    }
    const opts = { upsert: !!body.upsert };
    const result = body.multi
      ? await model.collection.updateMany(filter, update, opts)
      : await model.collection.updateOne(filter, update, opts);
    logger.info(`[devDb] update ${req.params.ns}.${req.params.model} matched=${result.matchedCount} modified=${result.modifiedCount}`);
    res.json({
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount || 0,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /admin/db/:ns/:model/delete — { filter, multi=false }
router.post('/:ns/:model/delete', async (req, res) => {
  const model = resolveModel(req, res);
  if (!model) return;
  try {
    const body = reviveDates(req.body || {});
    const { filter } = body;
    if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) {
      return res.status(400).json({ error: 'a non-empty filter is required' });
    }
    const result = body.multi
      ? await model.collection.deleteMany(filter)
      : await model.collection.deleteOne(filter);
    logger.warn(`[devDb] delete ${req.params.ns}.${req.params.model} deleted=${result.deletedCount}`);
    res.json({ deletedCount: result.deletedCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
