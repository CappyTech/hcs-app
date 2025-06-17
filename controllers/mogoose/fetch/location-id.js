const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/location/:id' route, replacing legacy Sequelize functionality.

router.all('/fetch/location/:id', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
