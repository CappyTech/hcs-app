const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/kashflow/supplier' route, replacing legacy Sequelize functionality.

router.all('/kashflow/supplier', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
