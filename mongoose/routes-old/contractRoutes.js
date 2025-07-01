const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/contractCRUDController');
const authService = require('../../services/authService');

// Contract routes
router.get('/contracts', authService.ensureRole(), ctrl.listContracts);
router.get('/contract/:id', authService.ensureRole(), ctrl.readContract);
router.post('/contract', authService.ensureRole(), ctrl.createContract);
router.post('/contract/:id/update', authService.ensureRole(), ctrl.updateContract);
router.post('/contract/:id/delete', authService.ensureRole(), ctrl.deleteContract);

// Assignment routes under contract

router.post('/contract/:contractId/assignment', authService.ensureRole(), ctrl.createAssignment);
router.get('/assignment/:id', authService.ensureRole(), ctrl.readAssignment);
router.post('/assignment/:id/update', authService.ensureRole(), ctrl.updateAssignment);
router.post('/assignment/:id/delete', authService.ensureRole(), ctrl.deleteAssignment);

module.exports = router;
