const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/employee' route, replacing legacy Sequelize functionality.

router.all('/employee', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
