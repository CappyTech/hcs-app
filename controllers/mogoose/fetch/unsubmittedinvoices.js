const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/unsubmittedinvoices' route, replacing legacy Sequelize functionality.

router.all('/fetch/unsubmittedinvoices', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
