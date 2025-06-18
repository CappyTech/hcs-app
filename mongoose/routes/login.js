const express = require('express');
const router = express.Router();
const login = require('../controllers/loginController');
const authService = require('../../services/authService');

router.get('/user/login', authService.doesntRequireLogin, login.renderLoginForm);
router.post('/user/login', authService.doesntRequireLogin, login.loginUser);
router.get('/user/logout', login.logoutUser);

module.exports = router;
