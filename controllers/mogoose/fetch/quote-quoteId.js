const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/quote/:quoteId' route, replacing legacy Sequelize functionality.

router.all('/fetch/quote/:quoteId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
