const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceCRUDController');

router.post('/attendance/create', authService.ensureRole(), ctrl.createAttendance);
router.get('/attendance/read/:uuid', authService.ensureRole(), ctrl.readAttendance);
router.post('/attendance/update/:uuid', authService.ensureRole(), ctrl.updateAttendance);
router.post('/attendance/delete/:uuid', authService.ensureRole(), ctrl.deleteAttendance);

module.exports = router;
