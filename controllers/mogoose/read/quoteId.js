const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/read/:quoteId' route, replacing legacy Sequelize functionality.

router.all('/read/:quoteId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
