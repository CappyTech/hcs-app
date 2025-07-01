const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/userCRUDController');

router.get('/users', authService.ensureRole(), ctrl.listUsers);
router.get('/user/create', authService.ensureRole(), ctrl.renderCreateUserForm);
router.post('/user/create', authService.ensureRole(), ctrl.createUser);
router.get('/user/read/:uuid', authService.ensureRole(), ctrl.readUser);
router.get('/user/update/:uuid', authService.ensureRole(), ctrl.renderUpdateUserForm);
router.post('/user/update/:uuid', authService.ensureRole(), ctrl.updateUser);
router.post('/user/delete/:uuid', authService.ensureRole(), ctrl.deleteUser);

router.get('/user/register', authService.ensureRole('none'), ctrl.renderRegistrationForm);
router.post('/user/register', authService.ensureRole('none'), ctrl.registerUser);

router.get('/user/login', authService.ensureRole('none'), ctrl.renderLoginForm);
router.post('/user/login', authService.ensureRole('none'), ctrl.loginUser);
router.get('/user/logout', authService.ensureRole(), ctrl.logoutUser);

module.exports = router;
