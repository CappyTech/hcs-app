const express = require('express');
const router = express.Router();
const authService = require('../../services/authService');
const ctrl = require('../controllers/userCRUDController');

router.get('/users', authService.ensureRole(), ctrl.listUsers);
router.get('/user/create', authService.ensureRole(), ctrl.renderCreateUserForm);
router.post('/user/create', authService.ensureRole(), ctrl.createUser);
router.get('/user/read/:uuid', authService.ensureRole(), ctrl.readUser);
router.get(
  '/user/update/:uuid',
  authService.ensureRole(),
  ctrl.renderUpdateUserForm || ((req, res) => res.end())
);
router.post('/user/update/:uuid', authService.ensureRole(), ctrl.updateUser);
router.post('/user/delete/:uuid', authService.ensureRole(), ctrl.deleteUser);

module.exports = router;
