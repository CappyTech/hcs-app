/**
 * Admin → Branding: upload or remove the app icon.
 *
 * The icon is the one image the app shows as its own: the browser tab, the
 * header, the footer, the installed app and the offline page. Everything
 * else that names the company (name, address, numbers) is on Configuration →
 * Organisation, and the brand colour is on Configuration → Appearance.
 *
 * Admin only (adminRoutes.js). Uploads are re-encoded to a 512×512 PNG by
 * brandService.normaliseUpload before anything is stored.
 */

import path from 'path';
import multer from 'multer';

import brand from '../../services/brandService.js';
import csrfService from '../../services/csrfService.js';
import auditLog from '../../services/auditLogService.js';
import logger from '../../services/loggerService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

/** GET /admin/branding */
export const getBranding = (req, res) => {
  res.render(path.join('tailwindcss', 'admin', 'branding'), {
    title: 'Branding',
    hasUpload: brand.hasUploadedIcon(),
    iconUrl: brand.iconUrl(192),
    colour: brand.brandColour(),
  });
};

/** POST /admin/branding/icon — multipart, field `icon`. */
export const postIcon = [
  (req, res, next) => {
    upload.single('icon')(req, res, (err) => {
      if (!err) return next();
      req.flash('error', err.code === 'LIMIT_FILE_SIZE'
        ? 'That image is over 2 MB. Use a smaller one.'
        : 'The upload could not be read. Try again.');
      return res.redirect('/admin/branding');
    });
  },
  csrfService.validate,
  async (req, res) => {
    try {
      const png = await brand.normaliseUpload(req.file?.buffer);
      await brand.saveIcon(png, req.user?.username || null);
      auditLog.record('app_icon_changed', req, { meta: { action: 'uploaded', bytes: png.length } });
      req.flash('success', 'The new icon is in place. Browsers pick it up on the next page you open.');
    } catch (err) {
      logger.warn(`[branding] Icon upload refused: ${err.message}`);
      req.flash('error', err.message);
    }
    res.redirect('/admin/branding');
  },
];

/** POST /admin/branding/icon/remove */
export const postRemoveIcon = async (req, res) => {
  try {
    await brand.removeIcon();
    auditLog.record('app_icon_changed', req, { meta: { action: 'removed' } });
    req.flash('success', 'The uploaded icon is removed. The app uses the plain mark in the brand colour.');
  } catch (err) {
    req.flash('error', `Could not remove the icon: ${err.message}`);
  }
  res.redirect('/admin/branding');
};

export default { getBranding, postIcon, postRemoveIcon };
