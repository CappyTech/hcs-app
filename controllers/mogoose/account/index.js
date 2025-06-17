const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/account' route, replacing legacy Sequelize functionality.

router.all('/account', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
