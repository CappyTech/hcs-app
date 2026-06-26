'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/auditController');

// The audit trail is admin-only.
router.get('/audit', authService.ensureRole('admin'), ctrl.getAuditLog);

module.exports = router;
