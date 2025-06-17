const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const quotes = require('../controllers/quotesController');

router.get('/quotes', auth.ensureAuthenticated, auth.ensureRole('admin'), quotes.listQuotes);
router.get('/quote/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), quotes.viewQuote);

module.exports = router;
