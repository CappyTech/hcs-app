const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const quotes = require('../controllers/quotesController');

router.get('/quotes',  auth.ensureRoles(['adminAccess']), quotes.listQuotes);
router.get('/quote/read/:uuid',  auth.ensureRoles(['adminAccess']), quotes.viewQuote);

module.exports = router;
