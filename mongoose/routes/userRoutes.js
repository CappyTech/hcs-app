const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/userCRUDController");

router.get(
  "/user/register",
  authService.ensureRole("public"),
  ctrl.renderRegistrationForm,
);
router.post(
  "/user/register",
  authService.ensureRole("public"),
  ctrl.registerUser,
);

router.get(
  "/user/login",
  authService.ensureRole("public"),
  ctrl.renderLoginForm,
);
router.post("/user/login", authService.ensureRole("public"), ctrl.loginUser);
router.get("/user/logout", authService.ensureAnyRole(), ctrl.logoutUser);

// Email verification
router.get(
  "/user/verify-email",
  authService.ensureRole("public"),
  ctrl.verifyEmail,
);
router.get(
  "/user/verify-pending",
  authService.ensureAnyRole(),
  ctrl.renderVerifyPending,
);
router.post(
  "/user/resend-verification",
  authService.ensureAnyRole(),
  ctrl.resendVerification,
);

module.exports = router;
