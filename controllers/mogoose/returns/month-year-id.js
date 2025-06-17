const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/returns/:month/:year/:id' route, replacing legacy Sequelize functionality.

router.all('/returns/:month/:year/:id', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
