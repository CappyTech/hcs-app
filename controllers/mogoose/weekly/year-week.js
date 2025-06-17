const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/weekly/:year?/:week?' route, replacing legacy Sequelize functionality.

router.all('/weekly/:year?/:week?', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
