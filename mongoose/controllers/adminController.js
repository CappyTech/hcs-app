"use strict";

const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const ropa = require("../config/ropaConfig");

const MODEL_LABEL = {
  purchase: (doc) =>
    `Purchase #${doc.Number}${doc.SupplierName ? " — " + doc.SupplierName : ""}`,
  invoice: (doc) =>
    `Invoice #${doc.Number}${doc.CustomerName ? " — " + doc.CustomerName : ""}`,
  customer: (doc) => doc.Name || doc.Code || String(doc.Id || ""),
  supplier: (doc) => doc.Name || doc.Code || String(doc.Id || ""),
  project: (doc) =>
    doc.Name ||
    doc.Reference ||
    (doc.Number ? `#${doc.Number}` : String(doc._id)),
  quote: (doc) =>
    `Quote #${doc.Number}${doc.CustomerName ? " — " + doc.CustomerName : ""}`,
  nominal: (doc) => `${doc.Code || ""} ${doc.Name || ""}`.trim(),
  note: (doc) =>
    `${doc.ObjectType || ""} #${doc.ObjectNumber || ""}: ${(doc.Text || "").slice(0, 60)}`,
};

const PAGE_SIZE = 50;

// Matches both lowercase `deletedAt` and PascalCase `DeletedAt` stored as BSON Date
const DELETED_FILTER = {
  $or: [
    { deletedAt: { $type: "date" } },
    { DeletedAt: { $type: "date" } },
  ],
};

exports.getDeletedItems = async (req, res, next) => {
  try {
    const filterModel = req.query.model || null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const skip = (page - 1) * PAGE_SIZE;

    // --- Per-model summary (counts + date range) via aggregation, no full doc loads ---
    const modelNames = Object.keys(MODEL_LABEL);
    const summaryPromises = modelNames.map(async (modelName) => {
      const model = mdb.REST[modelName];
      if (!model) return null;
      const [lc, pc] = await Promise.all([
        model.aggregate([
          { $match: { deletedAt: { $type: "date" } } },
          { $group: { _id: null, count: { $sum: 1 }, minDate: { $min: "$deletedAt" }, maxDate: { $max: "$deletedAt" } } },
        ]),
        model.aggregate([
          { $match: { DeletedAt: { $type: "date" } } },
          { $group: { _id: null, count: { $sum: 1 }, minDate: { $min: "$DeletedAt" }, maxDate: { $max: "$DeletedAt" } } },
        ]),
      ]);
      const lcCount = lc[0]?.count || 0;
      const pcCount = pc[0]?.count || 0;
      const total = lcCount + pcCount;
      if (total === 0) return null;
      const minDate = [lc[0]?.minDate, pc[0]?.minDate].filter(Boolean).sort()[0] || null;
      const maxDate = [lc[0]?.maxDate, pc[0]?.maxDate].filter(Boolean).sort().reverse()[0] || null;
      return { modelName, total, lcCount, pcCount, minDate, maxDate };
    });
    const summaryRaw = await Promise.all(summaryPromises);
    const summary = summaryRaw.filter(Boolean);
    const grandTotal = summary.reduce((s, r) => s + r.total, 0);

    // --- Monthly distribution across all models (for chart) ---
    const distPromises = modelNames.map(async (modelName) => {
      const model = mdb.REST[modelName];
      if (!model) return [];
      const [lc, pc] = await Promise.all([
        model.aggregate([
          { $match: { deletedAt: { $type: "date" } } },
          { $group: { _id: { y: { $year: "$deletedAt" }, m: { $month: "$deletedAt" } }, count: { $sum: 1 } } },
        ]),
        model.aggregate([
          { $match: { DeletedAt: { $type: "date" } } },
          { $group: { _id: { y: { $year: "$DeletedAt" }, m: { $month: "$DeletedAt" } }, count: { $sum: 1 } } },
        ]),
      ]);
      return [...lc, ...pc];
    });
    const distRaw = (await Promise.all(distPromises)).flat();
    // Merge counts by year-month key
    const distMap = new Map();
    for (const entry of distRaw) {
      const key = `${entry._id.y}-${String(entry._id.m).padStart(2, "0")}`;
      distMap.set(key, (distMap.get(key) || 0) + entry.count);
    }
    const distribution = [...distMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, count]) => ({ month, count }));

    // --- Paginated rows for selected (or all) model ---
    const matchModel = filterModel || null;
    const modelsToPage = matchModel ? [matchModel] : modelNames;

    // Count total for pagination
    let totalRows = 0;
    if (matchModel) {
      const s = summary.find((r) => r.modelName === matchModel);
      totalRows = s ? s.total : 0;
    } else {
      totalRows = grandTotal;
    }
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    const safeSkip = (safePage - 1) * PAGE_SIZE;

    // Fetch only the page's worth of records, spread across models
    const rows = [];
    let remaining = PAGE_SIZE;
    let toSkip = safeSkip;
    for (const modelName of modelsToPage) {
      if (remaining <= 0) break;
      const model = mdb.REST[modelName];
      if (!model) continue;
      const labelFn = MODEL_LABEL[modelName];

      // Count in this model
      const modelCount = (summary.find((r) => r.modelName === modelName) || {}).total || 0;
      if (modelCount === 0) continue;

      if (toSkip >= modelCount) {
        toSkip -= modelCount;
        continue;
      }

      const docs = await model
        .find(DELETED_FILTER)
        .sort({ deletedAt: -1, DeletedAt: -1 })
        .skip(toSkip)
        .limit(remaining)
        .lean();

      toSkip = 0;
      for (const doc of docs) {
        rows.push({
          model: modelName,
          label: labelFn(doc),
          deletedAt: doc.deletedAt || doc.DeletedAt,
          casing: doc.deletedAt ? "deletedAt" : "DeletedAt",
          uuid: doc.uuid || null,
        });
      }
      remaining -= docs.length;
    }

    res.render(path.join("tailwindcss", "admin", "deletedItems"), {
      title: "Deleted Items",
      summary,
      grandTotal,
      distribution,
      rows,
      page: safePage,
      totalPages,
      totalRows,
      filterModel,
      modelNames,
      pageSize: PAGE_SIZE,
    });
  } catch (err) {
    next(err);
  }
};

/** GET /admin/ui-guidelines — living component board */
exports.getUiGuidelines = (req, res) => {
  res.render(path.join('tailwindcss', 'admin', 'uiGuidelines'), {
    title: 'UI Component Board',
  });
};

exports.getGdprOverview = (_req, res) => {
  res.render(path.join("tailwindcss", "admin", "gdpr"), {
    title: "GDPR Compliance",
    ropaVersion: ropa.version,
    ropaLastUpdated: ropa.lastUpdated,
    activityCount: ropa.activities.length,
    processorCount: ropa.processors.length,
  });
};

exports.downloadRopa = (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="ropa.json"');
  res.json(ropa);
};

exports.viewIncidentResponse = (_req, res) => {
  res.render(path.join("tailwindcss", "admin", "gdprIncidentResponse"), {
    title: "Incident Response Playbook",
  });
};

exports.viewDpiaTemplate = (_req, res) => {
  res.render(path.join("tailwindcss", "admin", "gdprDpiaTemplate"), {
    title: "DPIA Template",
  });
};
