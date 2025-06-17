const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/signin' route, replacing legacy Sequelize functionality.

router.all('/signin', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
