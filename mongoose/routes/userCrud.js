const express = require('express');
const router = express.Router();
const auth = require('../../services/authService');
const ctrl = require('../controllers/userCRUDController');

router.post('/user/create', ctrl.createUser);
router.get('/user/read/:uuid', ctrl.readUser);
router.post('/user/update/:uuid', ctrl.updateUser);
router.post('/user/delete/:uuid', ctrl.deleteUser);

module.exports = router;
