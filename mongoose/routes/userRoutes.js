const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/userCRUDController');

router.get('/user/register', authService.ensureRole('none'), ctrl.renderRegistrationForm);
router.post('/user/register', authService.ensureRole('none'), ctrl.registerUser);

router.get('/user/login', authService.ensureRole('none'), ctrl.renderLoginForm);
router.post('/user/login', authService.ensureRole('none'), ctrl.loginUser);
router.get('/user/logout', authService.ensureAnyRole(), ctrl.logoutUser);

module.exports = router;
