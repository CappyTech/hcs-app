const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/delete/:jobId' route, replacing legacy Sequelize functionality.

router.all('/delete/:jobId', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
