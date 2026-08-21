import express from 'express';
const router = express.Router();
import path from 'path';
import { sessionCookieName } from '../../services/cookieNameService.js';

router.get('/legal/cookie-policy', (req, res) => {
  // The name is rendered rather than written into the page: it carries a
  // __Host- prefix wherever the deployment can guarantee Secure, and a cookie
  // policy that does not match what the browser shows is worse than none.
  // There is one cookie now — the CSRF token is no longer mirrored into one.
  res.render(path.join('tailwindcss', 'legal', 'cookie-policy'), {
    title: 'Cookie Policy',
    sessionCookieName: sessionCookieName(),
  });
});

router.get('/legal/privacy-policy', (req, res) => {
  res.render(path.join('tailwindcss', 'legal', 'privacy-policy'), {
    title: 'Privacy Policy',
  });
});

router.get('/legal/terms', (req, res) => {
  res.render(path.join('tailwindcss', 'legal', 'terms'), {
    title: 'Terms of Use',
  });
});

export default router;
