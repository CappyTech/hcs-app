const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const receipts = require('../controllers/receiptsListController');

router.get('/receipts', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), receipts.listReceipts);
router.get('/receipt/read/:uuid', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), receipts.viewReceipt);
router.post('/receipt/change', auth.ensureAuthenticated, auth.ensurePermission(['adminAccess']), receipts.changeReceipts);

module.exports = router;
