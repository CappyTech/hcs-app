const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const projects = require('../controllers/projectsController');

router.get('/projects', authService.ensureRole(), projects.listProjects);
router.get('/project/read/:uuid', authService.ensureRole(), projects.viewProject);

module.exports = router;
