const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/invoice/read/:uuid' route, replacing legacy Sequelize functionality.

router.all('/invoice/read/:uuid', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
