const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/:clientId' route, replacing legacy Sequelize functionality.

router.all('/fetch/:clientId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
