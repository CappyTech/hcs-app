const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/stats/:year?/:month?' route, replacing legacy Sequelize functionality.

router.all('/stats/:year?/:month?', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
