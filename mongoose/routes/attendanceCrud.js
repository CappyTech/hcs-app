const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/attendanceCRUDController');

router.post('/attendance/create', ctrl.createAttendance);
router.get('/attendance/read/:uuid', ctrl.readAttendance);
router.post('/attendance/update/:uuid', ctrl.updateAttendance);
router.post('/attendance/delete/:uuid', ctrl.deleteAttendance);

module.exports = router;
