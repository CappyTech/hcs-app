const express = require('express');
const router = express.Router();
// TODO: Implement MongoDB logic for '/account/logout-session' route, replacing legacy Sequelize functionality.

router.all('/account/logout-session', (req, res) => {
  res.status(501).json({ message: 'Not implemented' });
});

module.exports = router;
