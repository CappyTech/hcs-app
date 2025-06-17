const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/returns/:year' route, replacing legacy Sequelize functionality.

router.all('/returns/:year', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
