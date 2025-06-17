const express = require('express');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const authService = require('../../services/mongoose/authServiceMongoose');
const router = express.Router();
/*
router.get('/logs', authService.ensureAuthenticated, authService.ensureRole('admin'), async (req, res) => {
    const logPath = path.join(__dirname, '..', '..', 'logs', 'app.log');
    const lines = [];

    if (fs.existsSync(logPath)) {
        const rl = readline.createInterface({
            input: fs.createReadStream(logPath),
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            lines.push(line);
            if (lines.length > 200) lines.shift(); // keep last 200
        }
    } else {
        lines.push('Log file not found.');
    }

    res.render(path.join('admin', 'logger'), {
        title: 'Application Logs',
        lines
    });
});
*/
router.get('/logs', authService.ensureAuthenticated, authService.ensureRole('admin'), async (req, res) => {
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

    res.render(path.join('admin', 'logger'), {
        title: 'Application Logs',
        logsByLevel
    });
});

module.exports = router;