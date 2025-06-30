const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractCRUDController');
const assignmentController = require('../controllers/contractAssignmentCRUDController');

// Contract routes
router.get('/contracts', contractController.listContracts);
router.get('/contract/:id', contractController.readContract);
router.post('/contract', contractController.createContract);
router.post('/contract/:id/update', contractController.updateContract);
router.post('/contract/:id/delete', contractController.deleteContract);

// Assignment routes under contract
router.post('/contract/:contractId/assignment', assignmentController.createAssignment);

// Assignment standalone routes
router.get('/assignment/:id', assignmentController.readAssignment);
router.post('/assignment/:id/update', assignmentController.updateAssignment);
router.post('/assignment/:id/delete', assignmentController.deleteAssignment);

module.exports = router;
