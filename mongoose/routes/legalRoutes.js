import express from 'express';
const router = express.Router();
import path from 'path';

router.get('/legal/cookie-policy', (req, res) => {
  res.render(path.join('tailwindcss', 'legal', 'cookie-policy'), {
    title: 'Cookie Policy',
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
