const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const quotes = require('../controllers/quotesController');

router.get('/quotes', authService.ensureRole(), quotes.listQuotes);
router.get('/quote/read/:uuid', authService.ensureRole(), quotes.viewQuote);

module.exports = router;
