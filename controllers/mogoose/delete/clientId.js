const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/delete/:clientId' route, replacing legacy Sequelize functionality.

router.all('/delete/:clientId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
