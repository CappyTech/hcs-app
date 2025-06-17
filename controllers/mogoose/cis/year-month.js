const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/cis/:year?/:month?' route, replacing legacy Sequelize functionality.

router.all('/cis/:year?/:month?', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
