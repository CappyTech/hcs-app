const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/location' route, replacing legacy Sequelize functionality.

router.all('/location', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
