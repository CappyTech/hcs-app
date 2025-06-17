const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/update/:locationId' route, replacing legacy Sequelize functionality.

router.all('/update/:locationId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
