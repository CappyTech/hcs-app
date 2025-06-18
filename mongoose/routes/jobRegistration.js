const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/jobsController');

router.get('/job/register', authService.ensureRole(), ctrl.renderJobForm);
router.post('/job/register', authService.ensureRole(), ctrl.registerJob);
router.get('/jobs', authService.ensureRole(), ctrl.listJobs);

module.exports = router;
