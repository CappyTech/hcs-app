const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/job' route, replacing legacy Sequelize functionality.

router.all('/job', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
