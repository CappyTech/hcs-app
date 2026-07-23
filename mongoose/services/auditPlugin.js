import logger from '../../services/loggerService.js';
import auditContext from './auditContextService.js';
import __mongooseDatabaseService from './mongooseDatabaseService.js';

// Models whose single-record reads are logged (GDPR subject-access trail).
// Override via env, comma-separated. List reads are deliberately NOT logged.
const SENSITIVE_READ_MODELS = (process.env.AUDIT_SENSITIVE_MODELS || 'employee,payrollEntry')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Fields never worth snapshotting verbatim.
const IGNORED_DIFF_KEYS = new Set(['updatedAt', '__v']);

// Resolved lazily to avoid a require cycle with mongooseDatabaseService.
function auditModel() {
  try {
    return __mongooseDatabaseService.INTERNAL.auditLog;
  } catch (_) {
    return null;
  }
}

// Keeps snapshots small and JSON-safe: drops binary blobs and caps long strings.
function sanitize(obj) {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (Buffer.isBuffer(v)) out[k] = `[Buffer ${v.length} bytes]`;
    else if (typeof v === 'string' && v.length > 2000) out[k] = `${v.slice(0, 2000)}…[+${v.length - 2000} chars]`;
    else out[k] = v;
  }
  return out;
}

// Shallow field-level diff (good enough for an audit summary).
function diff(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (IGNORED_DIFF_KEYS.has(k)) continue;
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    if (JSON.stringify(b) !== JSON.stringify(a)) changes[k] = { from: b, to: a };
  }
  return changes;
}

// Writes one entry. Never throws — auditing must not break the real operation.
async function record(entry) {
  const Audit = auditModel();
  if (!Audit) return;
  // No context store at all = a background write outside any request → "System".
  // A request with no logged-in user keeps a blank actor (still has ip/route).
  const ctx = auditContext.get();
  try {
    await Audit.create({
      actor:      (ctx && ctx.actorId) || null,
      actorName:  ctx ? (ctx.actorName || '') : 'System',
      actorEmail: (ctx && ctx.actorEmail) || '',
      ip:         (ctx && ctx.ip) || '',
      method:     (ctx && ctx.method) || '',
      route:      (ctx && ctx.route) || '',
      ...entry,
    });
  } catch (err) {
    logger.error(`[auditPlugin] Failed to write audit entry (${entry.op} ${entry.collectionName}): ${err.message}`);
  }
}

// Marks internal book-keeping queries (our own before/after reads) so the read
// hook and nested hooks ignore them.
const INTERNAL_OPT = { _auditInternal: true };
const isInternal = (query) => !!query.getOptions()._auditInternal;

export default function auditPlugin(schema, options) {
  const modelName = (options && options.modelName) || 'unknown';

  // ── CREATE / UPDATE via document.save() ──────────────────────────────────
  schema.pre('save', async function () {
    this.$locals.auditIsNew = this.isNew;
    if (!this.isNew) {
      try {
        this.$locals.auditBefore = await this.constructor
          .findById(this._id).setOptions(INTERNAL_OPT).lean();
      } catch (_) { /* best-effort pre-image */ }
    }
  });

  schema.post('save', async function (doc) {
    const after = sanitize(doc.toObject());
    if (this.$locals.auditIsNew) {
      await record({ collectionName: modelName, op: 'create', docId: doc._id, docUuid: doc.uuid, after });
    } else {
      const before = sanitize(this.$locals.auditBefore);
      await record({
        collectionName: modelName, op: 'update', docId: doc._id, docUuid: doc.uuid,
        before, after, changes: diff(before, after),
      });
    }
  });

  // ── CREATE via insertMany ────────────────────────────────────────────────
  schema.post('insertMany', async function (docs) {
    for (const d of (Array.isArray(docs) ? docs : [docs])) {
      const obj = d && d.toObject ? d.toObject() : d;
      await record({ collectionName: modelName, op: 'create', docId: obj._id, docUuid: obj.uuid, after: sanitize(obj) });
    }
  });

  // ── UPDATE via query (findOneAndUpdate / updateOne / updateMany) ──────────
  const updateOps = ['findOneAndUpdate', 'updateOne', 'updateMany'];
  schema.pre(updateOps, { query: true, document: false }, async function () {
    if (isInternal(this)) return;
    try {
      this._auditBefore = await this.model.find(this.getFilter()).setOptions(INTERNAL_OPT).lean();
    } catch (_) { this._auditBefore = []; }
  });
  schema.post(updateOps, { query: true, document: false }, async function () {
    if (isInternal(this)) return;
    for (const b of (this._auditBefore || [])) {
      let after = null;
      try { after = await this.model.findById(b._id).setOptions(INTERNAL_OPT).lean(); } catch (_) { /* deleted? */ }
      const beforeS = sanitize(b);
      const afterS = sanitize(after);
      await record({
        collectionName: modelName, op: after ? 'update' : 'delete', docId: b._id, docUuid: b.uuid,
        before: beforeS, after: afterS, changes: after ? diff(beforeS, afterS) : undefined,
      });
    }
  });

  // ── DELETE via query (findOneAndDelete / deleteOne / deleteMany) ──────────
  const deleteOps = ['findOneAndDelete', 'deleteOne', 'deleteMany'];
  schema.pre(deleteOps, { query: true, document: false }, async function () {
    if (isInternal(this)) return;
    try {
      this._auditDeleted = await this.model.find(this.getFilter()).setOptions(INTERNAL_OPT).lean();
    } catch (_) { this._auditDeleted = []; }
  });
  schema.post(deleteOps, { query: true, document: false }, async function () {
    if (isInternal(this)) return;
    for (const b of (this._auditDeleted || [])) {
      await record({ collectionName: modelName, op: 'delete', docId: b._id, docUuid: b.uuid, before: sanitize(b) });
    }
  });

  // ── SENSITIVE READS (single record only) ─────────────────────────────────
  if (SENSITIVE_READ_MODELS.includes(modelName)) {
    schema.post('findOne', async function (doc) {
      if (isInternal(this) || !doc) return;
      await record({ collectionName: modelName, op: 'read', docId: doc._id, docUuid: doc.uuid });
    });
  }
};
