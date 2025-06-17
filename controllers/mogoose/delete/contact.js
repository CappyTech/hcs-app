const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/delete/:contact' route, replacing legacy Sequelize functionality.

router.all('/delete/:contact', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
