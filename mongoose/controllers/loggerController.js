const fs = require('fs');
const path = require('path');
const logger = require('../../services/loggerService');

const LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'app.json.log');

/**
 * Parse the JSON log file and return an array of parsed entries (newest last).
 * @param {number} [limit] – max lines to read from the tail of the file
 * @returns {object[]}
 */
function readLogEntries(limit = 500) {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
    const tail = limit ? lines.slice(-limit) : lines;
    const entries = [];
    tail.forEach(line => {
        try {
            entries.push(JSON.parse(line));
        } catch (_) { /* skip malformed */ }
    });
    return entries;
}

/**
 * Bucket entries by level.
 */
function bucketByLevel(entries) {
    const logsByLevel = { info: [], debug: [], warn: [], error: [] };
    entries.forEach(e => {
        const lvl = e.level?.toLowerCase();
        if (logsByLevel[lvl]) logsByLevel[lvl].push(e);
    });
    return logsByLevel;
}

/* ── GET /logs  (HTML page) ── */
exports.getLogs = async (req, res) => {
    const entries = readLogEntries(500);
    const logsByLevel = bucketByLevel(entries);

    res.render(path.join('tailwindcss', 'admin', 'logger'), {
        title: 'Application Logs',
        logsByLevel
    });
};

/* ── GET /logs/api?page=1&limit=100&level=error  (JSON – infinite scroll) ── */
exports.getLogsApi = async (req, res) => {
    try {
        const all = readLogEntries(2000);

        // Optional level filter
        const levelFilter = req.query.level?.toLowerCase();
        const filtered = levelFilter
            ? all.filter(e => e.level?.toLowerCase() === levelFilter)
            : all;

        // Sort newest-first
        filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Paginate
        const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
        const start = (page - 1) * limit;
        const items = filtered.slice(start, start + limit);

        res.json({
            page,
            limit,
            total: filtered.length,
            totalPages: Math.ceil(filtered.length / limit),
            items
        });
    } catch (err) {
        logger.error('Logs API error: ' + err.message);
        res.status(500).json({ error: 'Failed to read logs' });
    }
};

/* ── DELETE /logs/clear  (clear log file) ── */
exports.clearLogs = async (req, res) => {
    try {
        fs.writeFileSync(LOG_PATH, '', 'utf8');
        logger.info('Log file cleared by admin');
        res.json({ success: true });
    } catch (err) {
        logger.error('Clear logs error: ' + err.message);
        res.status(500).json({ error: 'Failed to clear logs' });
    }
};

/* ── GET /logs/download?level=error  (download as .jsonl) ── */
exports.downloadLogs = async (req, res) => {
    try {
        const all = readLogEntries(5000);
        const levelFilter = req.query.level?.toLowerCase();
        const filtered = levelFilter
            ? all.filter(e => e.level?.toLowerCase() === levelFilter)
            : all;

        const filename = levelFilter
            ? `logs-${levelFilter}-${Date.now()}.jsonl`
            : `logs-all-${Date.now()}.jsonl`;

        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(filtered.map(e => JSON.stringify(e)).join('\n'));
    } catch (err) {
        logger.error('Download logs error: ' + err.message);
        res.status(500).json({ error: 'Failed to download logs' });
    }
};