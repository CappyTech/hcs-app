const express = require('express');
const router = express.Router();
const path = require('path');
const authService = require('../services/authService');
const fetch = require('./fetchKashFlowData');
const logger = require('../services/loggerService');

let isFetching = false;
/*
// Route for rendering the fetch status page
router.get('/kashflow',  authService.ensureRoles('admin'), (req, res) => {
    res.render(path.join('kashflow', 'fetchStatus'), {
        title: 'Gathering KashFlow Data',
        isFetching,
    });
});
*/
const API_TOKEN = process.env.FETCH_API_TOKEN;

router.get('/fetch-kashflow-data', async (req, res) => {
    const token = req.query.token;
    const validToken = process.env.FETCH_API_TOKEN;

    if (!token || token !== validToken) {
        res.status(403).send('Forbidden: Invalid token');
        return;
    }

    // Set headers to enable streaming
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders();

    // Send updates to curl
    const sendUpdate = (msg) => {
        const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
        res.write(`${line}\n`);
    };

    // Simulate an authenticated user for downstream logic
    const fakeUser = {
        id: 0,
        username: 'token-triggered-bot',
        role: 'admin',
        tokenAuthenticated: true,
        touch: () => {}, // ← avoids crash
    };

    // Patch a fake session.user onto a mock req object if needed downstream
    req.session = { user: fakeUser };

    try {
        sendUpdate('⏳ Starting KashFlow fetch...');
        await fetch.fetchKashFlowData(sendUpdate); // hook in live updates
        sendUpdate('✅ All models processed. Fetch complete.');
    } catch (err) {
        sendUpdate(`❌ Error: ${err.message}`);
    } finally {
        res.end(); // End streaming cleanly
    }
});

/*
router.get('/fetch-status',  authService.ensureRoles('admin'), (req, res) => {
    res.status(200).json({
        messages: fetchMessages,
        completed: !isFetching,
        error: fetchError || null,
    });
});

const updateTaxMonthTaxYear = require('./updateTaxMonthTaxYear');

router.get('/update-tax-month-year',  authService.ensureRoles('admin'), async (req, res) => {
    try {
        await updateTaxMonthTaxYear();
        res.status(200).json({ message: 'Tax month and year updated successfully.' });
    } catch (error) {
        logger.error('Failed to update tax month and year:', error);
        res.status(500).json({ message: 'Failed to update tax month and year.' });
    }
});
*/
module.exports = router;

