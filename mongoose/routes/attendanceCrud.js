const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/attendanceCRUDController');

router.post('/attendance/create', authService.ensureRole(), ctrl.createAttendance);
router.get('/attendance/read/:id', authService.ensureRole(), ctrl.readAttendance);
router.post('/attendance/update/:id', authService.ensureRole(), ctrl.updateAttendance);
router.post('/attendance/delete/:id', authService.ensureRole(), ctrl.deleteAttendance);

module.exports = router;
