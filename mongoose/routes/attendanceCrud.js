const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/attendanceCRUDController');

router.post('/attendance/create', auth.ensureRole(), ctrl.createAttendance);
router.get('/attendance/read/:uuid', auth.ensureRole(), ctrl.readAttendance);
router.post('/attendance/update/:uuid', auth.ensureRole(), ctrl.updateAttendance);
router.post('/attendance/delete/:uuid', auth.ensureRole(), ctrl.deleteAttendance);

module.exports = router;
