const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const index = require('../controllers/indexController');

router.get('/', authService.ensureRole('none'), index.renderIndex);
router.get('/construction-industry-scheme', authService.ensureRoles('admin', 'accountant', 'hmrc', 'subcontractor'), index.renderConstructionIndustryScheme);
router.get('/management', authService.ensureRole('admin'), index.renderManagement);
router.get('/payroll', authService.ensureRole('admin'), index.renderPayroll);
router.get('/human-resources', authService.ensureRole('admin'), index.renderHumanResources);
router.get('/kashflow', authService.ensureRoles('admin', 'accountant'), index.renderKashflow);
router.get('/create', authService.ensureRole('admin'), index.renderCreate);
router.get('/paperless', authService.ensureRole('admin'), index.renderPaperless);
router.get('/finance', authService.ensureRoles('admin', 'accountant'), index.renderFinance);
/*
const fetch = require('../kashflowAPI/fetchKashFlowDataMongoose');
router.get('/fetch-kashflow-data-mongoose', async (req, res, next) => {
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
        next(err);
    } finally {
        res.end();
    }
});

const holidayService = require('../services/holidayServiceMongoose');
router.get('/fetch-holidays', async (req, res, next) => {
    const token = req.query.token;
    const validToken = process.env.FETCH_API_TOKEN;

    if (!token || token !== validToken) {
        err = new Error('Forbidden: Invalid token');
        return next(err);
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
        sendUpdate('⏳ Starting Mongoose-based holiday fetch...');
        await holidayService.fetchBankHolidays();
        sendUpdate('✅ Mongoose fetch complete.');
    } catch (err) {
        logger.error(`Mongoose fetch error: ${err.message}`);
        sendUpdate(`❌ Error: ${err.message}`);
        next(err);
    } finally {
        res.end();
    }
});
*/
module.exports = router;
