const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/cis' route, replacing legacy Sequelize functionality.

router.all('/cis', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
