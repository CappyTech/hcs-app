const express = require('express');
const router = express.Router();
const path = require('path');
const controller = require(path.join('..', 'controllers', 'submissionController'));

// POST: Update receipt submission date
router.post('/receipts/change-submission', controller.changeReceipts);

// POST: Update purchase submission date (REST)
router.post('/purchase/change', controller.changePurchases);

module.exports = router;
