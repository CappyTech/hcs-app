const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/register' route, replacing legacy Sequelize functionality.

router.all('/register', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
