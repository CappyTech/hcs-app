const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/fetch/subcontractor/:id' route, replacing legacy Sequelize functionality.

router.all('/fetch/subcontractor/:id', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
