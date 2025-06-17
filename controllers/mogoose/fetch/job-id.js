const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/job/:id' route, replacing legacy Sequelize functionality.

router.all('/fetch/job/:id', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
