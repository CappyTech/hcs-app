const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/receipt/:uuid/submit' route, replacing legacy Sequelize functionality.

router.all('/receipt/:uuid/submit', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
