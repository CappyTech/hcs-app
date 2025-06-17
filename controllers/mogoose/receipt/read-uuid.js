const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/receipt/read/:uuid' route, replacing legacy Sequelize functionality.

router.all('/receipt/read/:uuid', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
