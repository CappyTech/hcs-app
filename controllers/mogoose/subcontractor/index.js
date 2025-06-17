const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/subcontractor' route, replacing legacy Sequelize functionality.

router.all('/subcontractor', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
