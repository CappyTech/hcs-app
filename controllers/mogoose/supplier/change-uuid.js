const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/supplier/change/:uuid' route, replacing legacy Sequelize functionality.

router.all('/supplier/change/:uuid', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
