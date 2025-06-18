const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const receipts = require('../controllers/receiptsListController');

router.get('/receipts', receipts.listReceipts);
router.get('/receipt/read/:uuid', receipts.viewReceipt);
router.post('/receipt/change', receipts.changeReceipts);

module.exports = router;
