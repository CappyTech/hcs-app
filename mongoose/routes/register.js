const express = require('express');
const router = express.Router();
const register = require('../controllers/userCRUDController');
const authService = require('../../services/authService');

router.get('/user/register', authService.ensureRole('none'), register.renderRegistrationForm);
router.post('/user/register', authService.ensureRole('none'), register.registerUser);

module.exports = router;
