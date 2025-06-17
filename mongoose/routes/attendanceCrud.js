const express = require('express');
const router = express.Router();
const auth = require('../../services/mongoose/authServiceMongoose');
const ctrl = require('../controllers/attendanceCRUDController');

router.post('/attendance/create', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.createAttendance);
router.get('/attendance/read/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.readAttendance);
router.post('/attendance/update/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.updateAttendance);
router.post('/attendance/delete/:uuid', auth.ensureAuthenticated, auth.ensureRole('admin'), ctrl.deleteAttendance);

module.exports = router;
