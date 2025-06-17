const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/read/:jobId' route, replacing legacy Sequelize functionality.

router.all('/read/:jobId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
