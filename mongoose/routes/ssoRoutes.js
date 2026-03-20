const express = require("express");
const router = express.Router();

const ctrl = require("../controllers/ssoController");

// SSO handoff for hcs-sync.
// If user is not logged in, redirect to /user/login with a safe internal next URL.
router.get("/sso/hcs-sync", ctrl.hcsSyncHandoff);

module.exports = router;
