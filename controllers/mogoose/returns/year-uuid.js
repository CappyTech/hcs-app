const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/returns/:year/:uuid' route, replacing legacy Sequelize functionality.

router.all('/returns/:year/:uuid', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
