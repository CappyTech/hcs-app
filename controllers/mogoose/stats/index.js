const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/stats' route, replacing legacy Sequelize functionality.

router.all('/stats', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
