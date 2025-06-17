const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/contact/:clientId' route, replacing legacy Sequelize functionality.

router.all('/fetch/contact/:clientId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
