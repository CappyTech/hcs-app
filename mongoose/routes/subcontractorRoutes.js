const express = require('express');
const router = express.Router();
const path = require('path');
const controller = require(path.join('..', 'controllers', 'subcontractorController'));

// GET: Change subcontractor details
router.get('/supplier/change/:uuid', controller.renderChangeSupplierForm);

// POST: Submit subcontractor changes
router.post('/supplier/change/:uuid', controller.changeSupplier);

module.exports = router;
