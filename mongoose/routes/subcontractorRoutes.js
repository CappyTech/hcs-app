const express = require('express');
const router = express.Router();
const path = require('path');
const controller = require(path.join('..', 'controllers', 'subcontractorController'));

// GET: Assign a supplier as subcontractor
router.get('/subcontractor/assign', controller.renderAssignForm);

// POST: Assign a supplier as subcontractor
router.post('/subcontractor/assign', controller.assignSubcontractor);

// GET: Change subcontractor details
router.get('/supplier/change/:uuid', controller.renderChangeSupplierForm);

// POST: Submit subcontractor changes
router.post('/supplier/change/:uuid', controller.changeSupplier);

module.exports = router;
