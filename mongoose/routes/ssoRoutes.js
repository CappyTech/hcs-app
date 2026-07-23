import express from 'express';
import rateLimit from 'express-rate-limit';
const router = express.Router();

import ctrl from '../controllers/ssoController.js';

// Tight rate limit for the credential-validation endpoint.
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: JSON.stringify({ error: "Too many requests, try again later." }),
});

// SSO handoff for hcs-sync (browser redirect flow — kept for fallback).
// If user is not logged in, redirect to /user/login with a safe internal next URL.
router.get("/sso/hcs-sync", ctrl.hcsSyncHandoff);

// Machine-to-machine token issuance: hcs-sync login form calls this to
// validate credentials and receive a signed JWT without a browser redirect.
router.post("/api/sso/token", tokenLimiter, ctrl.issueTokenForSync);

export default router;
