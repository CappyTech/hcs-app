const fs = require("fs");
const path = require("path");
const logger = require("../../services/loggerService");
const mdb = require("../services/mongooseDatabaseService");

const LOG_PATH = path.join(__dirname, "..", "..", "logs", "app.json.log");

/**
 * Parse the JSON log file and return an array of parsed entries (newest last).
 * @param {number} [limit] – max lines to read from the tail of the file
 * @returns {object[]}
 */
function readLogEntries(limit = 500) {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
  const tail = limit ? lines.slice(-limit) : lines;
  const entries = [];
  tail.forEach((line) => {
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      /* skip malformed */
    }
  });
  return entries;
}

/**
 * Bucket entries by level.
 */
function bucketByLevel(entries) {
  const logsByLevel = { info: [], debug: [], warn: [], error: [] };
  entries.forEach((e) => {
    const lvl = e.level?.toLowerCase();
    if (logsByLevel[lvl]) logsByLevel[lvl].push(e);
  });
  return logsByLevel;
}

/* ── GET /logs  (HTML page) ── */
exports.getLogs = async (req, res) => {
  const entries = readLogEntries(500);
  const logsByLevel = bucketByLevel(entries);

  res.render(path.join("tailwindcss", "admin", "logger"), {
    title: "Application Logs",
    logsByLevel,
  });
};

/* ── GET /logs/api?page=1&limit=100&level=error  (JSON – infinite scroll) ── */
exports.getLogsApi = async (req, res) => {
  try {
    const all = readLogEntries(2000);

    // Optional level filter
    const levelFilter = req.query.level?.toLowerCase();
    const filtered = levelFilter
      ? all.filter((e) => e.level?.toLowerCase() === levelFilter)
      : all;

    // Sort newest-first
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Paginate
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      500,
    );
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    res.json({
      page,
      limit,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / limit),
      items,
    });
  } catch (err) {
    logger.error("Logs API error: " + err.message);
    res.status(500).json({ error: "Failed to read logs" });
  }
};

/* ── DELETE /logs/clear  (clear log file) ── */
exports.clearLogs = async (req, res) => {
  try {
    fs.writeFileSync(LOG_PATH, "", "utf8");
    logger.info("Log file cleared by admin");
    res.json({ success: true });
  } catch (err) {
    logger.error("Clear logs error: " + err.message);
    res.status(500).json({ error: "Failed to clear logs" });
  }
};

/* ── GET /logs/download?level=error  (download as .jsonl) ── */
exports.downloadLogs = async (req, res) => {
  try {
    const all = readLogEntries(5000);
    const levelFilter = req.query.level?.toLowerCase();
    const filtered = levelFilter
      ? all.filter((e) => e.level?.toLowerCase() === levelFilter)
      : all;

    const filename = levelFilter
      ? `logs-${levelFilter}-${Date.now()}.jsonl`
      : `logs-all-${Date.now()}.jsonl`;

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(filtered.map((e) => JSON.stringify(e)).join("\n"));
  } catch (err) {
    logger.error("Download logs error: " + err.message);
    res.status(500).json({ error: "Failed to download logs" });
  }
};

// ── Shared helper for MongoDB API log pages ──────────────────────────────────

async function getApiLogPage(res, { modelName, title, source }) {
  try {
    const model = mdb.INTERNAL?.[modelName];
    if (!model) {
      return res.render(path.join("tailwindcss", "admin", "apiLogs"), {
        title,
        source,
        entries: [],
        stats: { request: 0, response: 0, error: 0 },
        unavailable: true,
      });
    }

    const limit = 500;
    const entries = await model
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const stats = { request: 0, response: 0, error: 0 };
    for (const e of entries) {
      if (e.direction === 'request') stats.request++;
      else if (e.direction === 'response') stats.response++;
      else if (e.direction === 'error') stats.error++;
    }

    res.render(path.join("tailwindcss", "admin", "apiLogs"), {
      title,
      source,
      entries,
      stats,
      unavailable: false,
    });
  } catch (err) {
    logger.error(`${title} logs page error: ${err.message}`);
    res.status(500).render("error", { message: "Failed to load API logs." });
  }
}

/* ── GET /logs/kashflow  (KashFlow API log viewer) ── */
exports.getKashflowApiLogs = (req, res) =>
  getApiLogPage(res, { modelName: 'kashflowApiLog', title: 'KashFlow API Logs', source: 'kashflow' });

/* ── GET /logs/paperless  (Paperless API log viewer) ── */
exports.getPaperlessApiLogs = (req, res) =>
  getApiLogPage(res, { modelName: 'paperlessApiLog', title: 'Paperless API Logs', source: 'paperless' });

/* ── GET /logs/kashflow/data  (JSON — for live refresh) ── */
exports.getKashflowApiLogsData = async (req, res) => {
  try {
    const model = mdb.INTERNAL?.kashflowApiLog;
    if (!model) return res.json({ entries: [] });
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const direction = req.query.direction;
    const filter = direction ? { direction } : {};
    const entries = await model.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* ── GET /logs/paperless/data  (JSON — for live refresh) ── */
exports.getPaperlessApiLogsData = async (req, res) => {
  try {
    const model = mdb.INTERNAL?.paperlessApiLog;
    if (!model) return res.json({ entries: [] });
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const direction = req.query.direction;
    const filter = direction ? { direction } : {};
    const entries = await model.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
