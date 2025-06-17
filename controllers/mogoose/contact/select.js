const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/contact/select' route, replacing legacy Sequelize functionality.

router.all('/contact/select', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
