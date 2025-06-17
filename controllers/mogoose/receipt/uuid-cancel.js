const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/receipt/:uuid/cancel' route, replacing legacy Sequelize functionality.

router.all('/receipt/:uuid/cancel', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
