const express = require('express');
const router = express.Router();
const login = require('../controllers/loginController');

router.get('/user/login', login.renderLoginForm);
router.post('/user/login', login.loginUser);
router.get('/user/logout', login.logoutUser);

module.exports = router;
