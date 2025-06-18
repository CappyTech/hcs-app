const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const receipts = require('../controllers/receiptsListController');

router.get('/receipts',  auth.ensureRoles(['adminAccess']), receipts.listReceipts);
router.get('/receipt/read/:uuid',  auth.ensureRoles(['adminAccess']), receipts.viewReceipt);
router.post('/receipt/change',  auth.ensureRoles(['adminAccess']), receipts.changeReceipts);

module.exports = router;
