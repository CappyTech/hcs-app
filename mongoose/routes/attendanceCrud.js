const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/attendanceCRUDController');

router.post('/attendance/create',  auth.ensureRoles(['adminAccess']), ctrl.createAttendance);
router.get('/attendance/read/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.readAttendance);
router.post('/attendance/update/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.updateAttendance);
router.post('/attendance/delete/:uuid',  auth.ensureRoles(['adminAccess']), ctrl.deleteAttendance);

module.exports = router;
