const fs = require('fs');
const path = require('path');
exports.getLogs = async (req, res) => {
    const logPath = path.join(__dirname, '..', '..', 'logs', 'app.json.log');
    const logsByLevel = {
        info: [],
        debug: [],
        warn: [],
        error: []
    };

    if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');

        lines.slice(-500).forEach(line => {
            try {
                const parsed = JSON.parse(line);
                const level = parsed.level?.toLowerCase();
                if (logsByLevel[level]) {
                    logsByLevel[level].push(parsed);
                }
            } catch (err) {
                // Skip malformed lines
            }
        });
    }

    res.render(path.join('mongoose', 'admin', 'logger'), {
        title: 'Application Logs',
        logsByLevel
    });
};