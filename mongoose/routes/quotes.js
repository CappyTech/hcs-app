const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const quotes = require('../controllers/quotesController');

router.get('/quotes', auth.ensureRole(), quotes.listQuotes);
router.get('/quote/read/:uuid', auth.ensureRole(), quotes.viewQuote);

module.exports = router;
