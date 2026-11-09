import express from 'express';
import path from 'path';
import authService from '../../services/authService.js';
import { runCheck } from '../services/dataCheckService.js';

const router = express.Router();

// Data check (/admin/data-check): admin only, read only.
router.get('/admin/data-check', authService.ensureRole('admin'), async (req, res, next) => {
  try {
    const result = await runCheck();
    res.render(path.join('tailwindcss', 'admin', 'dataCheck'), { title: 'Data check', result });
  } catch (err) {
    next(err);
  }
});

export default router;
