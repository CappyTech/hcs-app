const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/project/:uuid/:number/download/:filename' route, replacing legacy Sequelize functionality.

router.all('/project/:uuid/:number/download/:filename', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
