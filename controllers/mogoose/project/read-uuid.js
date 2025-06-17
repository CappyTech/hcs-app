const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/project/read/:uuid' route, replacing legacy Sequelize functionality.

router.all('/project/read/:uuid', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
