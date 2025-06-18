const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/tasksController');

router.get('/task/create', authService.ensureRole(), ctrl.renderCreateTaskForm);
router.post('/task/create', authService.ensureRole(), ctrl.createTask);

module.exports = router;
