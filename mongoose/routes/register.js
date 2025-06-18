const express = require('express');
const router = express.Router();
const register = require('../controllers/registerController');
const authService = require('../../services/authService');

router.get('/user/register', authService.doesntRequireLogin, register.renderRegistrationForm);
router.post('/user/register', authService.doesntRequireLogin, register.registerUser);

module.exports = router;
