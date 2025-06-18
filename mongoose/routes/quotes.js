const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const quotes = require('../controllers/quotesController');

router.get('/quotes', quotes.listQuotes);
router.get('/quote/read/:uuid', quotes.viewQuote);

module.exports = router;
