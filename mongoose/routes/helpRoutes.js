'use strict';

const express = require('express');
const router  = express.Router();
const authService = require('../../services/authService');
const helpController = require('../controllers/helpController');

router.get('/help', authService.ensureAnyRole(), helpController.getHelp);

module.exports = router;
