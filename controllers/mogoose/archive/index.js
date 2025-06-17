const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/archive' route, replacing legacy Sequelize functionality.

router.all('/archive', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
