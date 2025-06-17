const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/returns/form' route, replacing legacy Sequelize functionality.

router.all('/returns/form', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
