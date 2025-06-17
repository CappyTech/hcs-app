const express = require('express');
const router = express.Router();
const login = require('../controllers/loginController');

router.get('/user/signin', login.renderSigninForm);
router.post('/user/login', login.loginUser);
router.get('/user/logout', login.logoutUser);

module.exports = router;
