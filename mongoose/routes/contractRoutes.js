const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractCRUDController');
const assignmentController = require('../controllers/contractAssignmentCRUDController');
const authService = require('../../services/authService');

// Contract routes
router.get('/contracts', authService.ensureRole(), contractController.listContracts);
router.get('/contract/:id', authService.ensureRole(), contractController.readContract);
router.post('/contract', authService.ensureRole(), contractController.createContract);
router.post('/contract/:id/update', authService.ensureRole(), contractController.updateContract);
router.post('/contract/:id/delete', authService.ensureRole(), contractController.deleteContract);

// Assignment routes under contract
router.post('/contract/:contractId/assignment', authService.ensureRole(), assignmentController.createAssignment);

// Assignment standalone routes
router.get('/assignment/:id', authService.ensureRole(), assignmentController.readAssignment);
router.post('/assignment/:id/update', authService.ensureRole(), assignmentController.updateAssignment);
router.post('/assignment/:id/delete', authService.ensureRole(), assignmentController.deleteAssignment);

module.exports = router;
