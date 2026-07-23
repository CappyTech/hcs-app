import mdb from '../services/mongooseDatabaseService.js';

const PAGE_SIZE = 50;

// Read-only viewer for the INTERNAL audit trail. Admin-only (enforced on the route).
export const getAuditLog = async (req, res, next) => {
  try {
    const Audit = mdb.INTERNAL.auditLog;

    // ── Filters ───────────────────────────────────────────────────────────────
    const filter = {};
    if (req.query.collection) filter.collectionName = req.query.collection;
    if (['create', 'update', 'delete', 'read'].includes(req.query.op)) filter.op = req.query.op;
    const q = (req.query.q || '').trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ actorName: rx }, { actorEmail: rx }, { docUuid: rx }];
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const [entries, total, collections] = await Promise.all([
      Audit.find(filter).sort({ at: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      Audit.countDocuments(filter),
      Audit.distinct('collectionName'),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    res.render('tailwindcss/audit/index', {
      title: 'Audit Log',
      entries,
      collections: collections.sort(),
      total,
      page,
      totalPages,
      filters: { collection: req.query.collection || '', op: req.query.op || '', q },
    });
  } catch (err) {
    next(err);
  }
};

export default { getAuditLog };
