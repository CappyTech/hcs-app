import express from 'express';
const router = express.Router();
import path from 'path';
import { sessionCookieName, csrfCookieName } from '../../services/cookieNameService.js';

router.get('/legal/cookie-policy', (req, res) => {
  // The names are rendered rather than written into the page: they carry a
  // __Host- prefix wherever the deployment can guarantee Secure, and a cookie
  // policy that does not match what the browser shows is worse than none.
  res.render(path.join('tailwindcss', 'legal', 'cookie-policy'), {
    title: 'Cookie Policy',
    sessionCookieName: sessionCookieName(),
    csrfCookieName: csrfCookieName(),
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
