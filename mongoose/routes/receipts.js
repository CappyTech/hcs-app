const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const receipts = require('../controllers/receiptsListController');

router.get('/receipts', auth.ensureAuthenticated, auth.ensureRole('admin'), receipts.listReceipts);
router.get('/receipt/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), receipts.viewReceipt);

module.exports = router;
