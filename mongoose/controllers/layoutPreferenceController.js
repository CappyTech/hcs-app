import layoutPreference from '../services/layoutPreferenceService.js';
import logger from '../../services/loggerService.js';

/**
 * The "Layout" section of Account Settings (/user/account). The form posts
 * here; the new width shows on the next page load.
 */
export const postLayout = async (req, res) => {
  try {
    const pref = layoutPreference.fromForm(req.body);
    await layoutPreference.save(req.user._id, pref);
    const label = layoutPreference.WIDTHS.find((w) => w.value === pref.contentWidth)?.label || pref.contentWidth;
    req.flash('success', `Page width set to ${label}.`);
  } catch (err) {
    logger.warn(`[layoutPreference] save failed: ${err.message}`);
    req.flash('error', `Your layout could not be saved. ${err.message}`);
  }
  return res.redirect('/user/account#layout');
};

export const postLayoutReset = async (req, res) => {
  try {
    await layoutPreference.reset(req.user._id);
    req.flash('success', 'Page width is back to the company default.');
  } catch (err) {
    logger.warn(`[layoutPreference] reset failed: ${err.message}`);
    req.flash('error', 'Your layout could not be reset.');
  }
  return res.redirect('/user/account#layout');
};

export default { postLayout, postLayoutReset };
