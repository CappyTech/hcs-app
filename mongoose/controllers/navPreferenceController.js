import navPreference from '../services/navPreferenceService.js';
import navigation from '../../services/navigationService.js';
import logger from '../../services/loggerService.js';

/**
 * The "Navigation style" section of Account Settings (/user/account). The
 * form posts here; the new style shows on the next page load.
 */
export const postNavigation = async (req, res) => {
  try {
    const nav = res.locals.nav || navigation.build({ path: req.path, user: req.user });
    const pref = navPreference.fromForm(req.body, nav);
    await navPreference.save(req.user._id, pref);
    const label = navPreference.STYLES.find((s) => s.value === pref.navStyle)?.label || pref.navStyle;
    req.flash('success', `Navigation set to ${label}.`);
  } catch (err) {
    logger.warn(`[navPreference] save failed: ${err.message}`);
    req.flash('error', `Your navigation style could not be saved. ${err.message}`);
  }
  return res.redirect('/user/account');
};

export const postNavigationReset = async (req, res) => {
  try {
    await navPreference.reset(req.user._id);
    req.flash('success', 'Navigation is back to the company default.');
  } catch (err) {
    logger.warn(`[navPreference] reset failed: ${err.message}`);
    req.flash('error', 'Your navigation style could not be reset.');
  }
  return res.redirect('/user/account');
};

export default { postNavigation, postNavigationReset };
