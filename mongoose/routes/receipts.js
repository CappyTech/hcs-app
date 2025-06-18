const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const receipts = require('../controllers/receiptsListController');

router.get('/receipts', auth.ensureRole(), receipts.listReceipts);
router.get('/receipt/read/:uuid', auth.ensureRole(), receipts.viewReceipt);
router.post('/receipt/change', auth.ensureRole(), receipts.changeReceipts);

module.exports = router;
