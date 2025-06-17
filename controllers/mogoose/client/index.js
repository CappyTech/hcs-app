const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/client' route, replacing legacy Sequelize functionality.

router.all('/client', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
