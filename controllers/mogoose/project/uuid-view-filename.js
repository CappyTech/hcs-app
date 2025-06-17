const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/project/:uuid/view/:filename' route, replacing legacy Sequelize functionality.

router.all('/project/:uuid/view/:filename', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
