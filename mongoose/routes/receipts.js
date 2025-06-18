const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const receipts = require('../controllers/receiptsListController');

router.get('/receipts', authService.ensureRole(), receipts.listReceipts);
router.get('/receipt/read/:uuid', authService.ensureRole(), receipts.viewReceipt);
router.post('/receipt/change', authService.ensureRole(), receipts.changeReceipts);

module.exports = router;
