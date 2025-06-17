const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/kashflow/receipt' route, replacing legacy Sequelize functionality.

router.all('/kashflow/receipt', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
