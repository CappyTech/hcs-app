const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/update/:invoice' route, replacing legacy Sequelize functionality.

router.all('/update/:invoice', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
