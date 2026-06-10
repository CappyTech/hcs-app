const express = require("express");
const router = express.Router();
const authService = require("../../services/authService");
const ctrl = require("../controllers/userCRUDController");
const { registerRateLimiter } = require("../../services/rateLimiterService");

router.get(
  "/user/register",
  authService.ensureRole("public"),
  ctrl.renderRegistrationForm,
);
router.post(
  "/user/register",
  authService.ensureRole("public"),
  registerRateLimiter,
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

// Forgot / reset password
router.get(
  "/user/forgot-password",
  authService.ensureRole("public"),
  ctrl.renderForgotPasswordForm,
);
router.post(
  "/user/forgot-password",
  authService.ensureRole("public"),
  ctrl.sendPasswordReset,
);
router.get(
  "/user/forgot-password/choose",
  authService.ensureRole("public"),
  ctrl.renderChooseResetMethod,
);
router.post(
  "/user/forgot-password/choose",
  authService.ensureRole("public"),
  ctrl.dispatchResetMethod,
);
router.get(
  "/user/reset-password",
  authService.ensureRole("public"),
  ctrl.renderResetPasswordForm,
);
router.post(
  "/user/reset-password",
  authService.ensureRole("public"),
  ctrl.resetPassword,
);
router.get(
  "/user/verify-sms-otp",
  authService.ensureRole("public"),
  ctrl.renderVerifySmsOtp,
);
router.post(
  "/user/verify-sms-otp",
  authService.ensureRole("public"),
  ctrl.verifySmsOtp,
);
router.get(
  "/user/verify-totp-reset",
  authService.ensureRole("public"),
  ctrl.renderVerifyTotpReset,
);
router.post(
  "/user/verify-totp-reset",
  authService.ensureRole("public"),
  ctrl.verifyTotpReset,
);

module.exports = router;
