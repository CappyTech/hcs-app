const express = require('express');
const router = express.Router();
const fetch = require('./fetchKashFlowDataMongoose');
const logger = require('../../services/loggerService');

router.get('/fetch-kashflow-data-mongoose', async (req, res) => {
    const token = req.query.token;
    const validToken = process.env.FETCH_API_TOKEN;

    if (!token || token !== validToken) {
        return res.status(403).send('Forbidden: Invalid token');
    }

    // Streaming headers
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders();

    // Stream function
    const sendUpdate = (msg) => {
        const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
        res.write(`${line}\n`);
    };

    try {
        sendUpdate('⏳ Starting Mongoose-based KashFlow fetch...');
        await fetch.fetchKashFlowDataMongoose(sendUpdate);
        sendUpdate('✅ Mongoose fetch complete.');
    } catch (err) {
        logger.error(`Mongoose fetch error: ${err.message}`);
        sendUpdate(`❌ Error: ${err.message}`);
    } finally {
        res.end();
    }
});

module.exports = router;
