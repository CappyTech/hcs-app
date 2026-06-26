'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/companyDocsController');

// All company-docs routes are admin-only
const adminOnly = authService.ensureRole('admin');

router.get('/company-docs',                        adminOnly, ctrl.getIndex);
router.get('/company-docs/letterhead',             adminOnly, ctrl.getLetterhead);
router.get('/company-docs/letterhead/logo',        adminOnly, ctrl.getLetterheadLogo);
router.post('/company-docs/letterhead',            adminOnly, ...ctrl.postLetterhead);
router.get('/company-docs/policies',               adminOnly, ctrl.getPolicyList);
router.get('/company-docs/policies/create',        adminOnly, ctrl.getCreatePolicy);
router.post('/company-docs/policies',              adminOnly, ctrl.postCreatePolicy);
router.get('/company-docs/policies/:uuid/edit',    adminOnly, ctrl.getEditPolicy);
router.post('/company-docs/policies/:uuid',        adminOnly, ctrl.postEditPolicy);
router.post('/company-docs/policies/:uuid/delete', adminOnly, ctrl.postDeletePolicy);
router.get('/company-docs/policies/:uuid/print',   adminOnly, ctrl.getPrintPolicy);

module.exports = router;
