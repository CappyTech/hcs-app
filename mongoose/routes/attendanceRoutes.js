const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceCRUDController');

//CRUD routes for Attendance
router.get('/attendances', authService.ensureRole(), ctrl.listAttendances);
router.get('/attendance/create', authService.ensureRole(), ctrl.renderCreateAttendanceForm);
router.post('/attendance/create', authService.ensureRole(), ctrl.createAttendance);
router.get('/attendance/read/:id', authService.ensureRole(), ctrl.readAttendance);
router.get('/attendance/update/:id', authService.ensureRole(), ctrl.renderUpdateAttendanceForm);
router.post('/attendance/update/:id', authService.ensureRole(), ctrl.updateAttendance);
router.post('/attendance/delete/:id', authService.ensureRole(), ctrl.deleteAttendance);

router.get('/attendance/daily/:date?', authService.ensureRole(), ctrl.getDailyAttendance);

module.exports = router;
