const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/quote' route, replacing legacy Sequelize functionality.

router.all('/quote', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
