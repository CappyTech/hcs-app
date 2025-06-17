const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/create/:client' route, replacing legacy Sequelize functionality.

router.all('/create/:client', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
