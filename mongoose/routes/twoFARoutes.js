const express = require("express");
const router = express.Router();
const twoFA = require("../controllers/twoFAController");

// No session auth guard here — users at this step only have userPending2FA,
// not a full session. The controller validates userPending2FA itself.
router.get("/user/2fa", twoFA.render2FAPage);
router.post("/user/2fa", twoFA.verify2FA);

module.exports = router;
