const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/delete/:invoice' route, replacing legacy Sequelize functionality.

router.all('/delete/:invoice', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
