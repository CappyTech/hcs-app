const express = require('express');
const router = express.Router();
const register = require('../controllers/registerController');

router.get('/user/register', register.renderRegistrationForm);
router.post('/user/register', register.registerUser);

module.exports = router;
