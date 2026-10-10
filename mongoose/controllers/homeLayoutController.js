import path from 'path';
import homeLayout from '../services/homeLayoutService.js';
import overviewConfig from '../services/overviewConfigService.js';
import logger from '../../services/loggerService.js';

/**
 * Choosing what home shows. People customise their own (/home/customise);
 * admins set the starting layout per role (/admin/overviews/home/:role).
 * Both use the same form. A person only ever sees pins they may open; a role
 * default can hold anything, and each viewer still gets only their share.
 */
const view = path.join('tailwindcss', 'home', 'customise');
const ROLE_CHOICES = overviewConfig.ROLES.filter((r) => r !== 'none');

// Selected pins with their position, for the form
function selection(layout) {
  const pos = {};
  for (const kind of ['areas', 'figures', 'lists']) (layout[kind] || []).forEach((k, i) => { pos[k] = i + 1; });
  return pos;
}

// `layout` is express-ejs-layouts' own local (the page template's path), so
// the pins are passed as `selected` only; a `layout` object here is a 500.
function render(res, { layout, ...opts }) {
  res.render(view, { ...opts, selected: selection(layout), limits: homeLayout.LIMITS });
}

// ── Your own home ────────────────────────────────────────────────────────
export const getCustomise = async (req, res, next) => {
  try {
    const { layout, source } = await homeLayout.resolve(req);
    render(res, {
      title: 'Customise home',
      heading: 'Customise your home page',
      intro: source === 'user'
        ? 'This is your own layout.'
        : (source === 'role' ? 'You are using the layout set for your role. Saving makes it your own.' : 'You are using the standard layout. Saving makes it your own.'),
      action: '/home/customise',
      resetAction: source === 'user' ? '/home/customise/reset' : null,
      resetLabel: 'Go back to the standard layout',
      back: { href: '/', label: '← Home' },
      groups: homeLayout.options(req),
      layout,
    });
  } catch (err) { next(err); }
};

export const postCustomise = async (req, res) => {
  try {
    const allowed = homeLayout.allKeys(homeLayout.options(req));
    await homeLayout.save('user', req.user._id, homeLayout.fromForm(req.body, allowed), req.user._id);
    req.flash('success', 'Your home page is saved.');
    return res.redirect('/');
  } catch (err) {
    logger.warn(`[homeLayout] save failed: ${err.message}`);
    req.flash('error', 'Your home page could not be saved. Please try again.');
    return res.redirect('/home/customise');
  }
};

export const postReset = async (req, res) => {
  try {
    await homeLayout.reset('user', req.user._id);
    req.flash('success', 'Your home page is back to the standard layout.');
  } catch (err) {
    logger.warn(`[homeLayout] reset failed: ${err.message}`);
    req.flash('error', 'Your home page could not be reset.');
  }
  return res.redirect('/');
};

// ── Role defaults (admin) ────────────────────────────────────────────────
function roleParam(req) {
  return ROLE_CHOICES.includes(req.params.role) ? req.params.role : null;
}

export const getRoleDefault = async (req, res, next) => {
  try {
    const role = roleParam(req);
    if (!role) return next();
    const stored = await homeLayout.resolve({ user: { role } });
    // Nothing stored: start from what that role would see today, not every area
    const layout = stored.source === 'role' ? stored.layout : homeLayout.builtIn({ user: { role, customPermissions: {} } });
    render(res, {
      title: `Home for ${role}`,
      heading: `Starting home page for the ${role} role`,
      intro: `People with the ${role} role see this until they customise their own. Each person still sees only what their permissions allow, so pins they can't open are left out for them.`,
      action: `/admin/overviews/home/${role}`,
      resetAction: stored.source === 'role' ? `/admin/overviews/home/${role}/reset` : null,
      resetLabel: 'Go back to the standard layout',
      back: { href: '/admin/overviews', label: '← Overview settings' },
      roles: ROLE_CHOICES,
      role,
      groups: homeLayout.options(null),
      layout,
    });
  } catch (err) { next(err); }
};

export const postRoleDefault = async (req, res, next) => {
  const role = roleParam(req);
  if (!role) return next();
  try {
    const allowed = homeLayout.allKeys(homeLayout.options(null));
    await homeLayout.save('role', role, homeLayout.fromForm(req.body, allowed), req.user._id);
    req.flash('success', `Saved the starting home page for ${role}.`);
  } catch (err) {
    logger.warn(`[homeLayout] role save failed: ${err.message}`);
    req.flash('error', 'That layout could not be saved.');
  }
  return res.redirect(`/admin/overviews/home/${role}`);
};

export const postRoleReset = async (req, res, next) => {
  const role = roleParam(req);
  if (!role) return next();
  try {
    await homeLayout.reset('role', role);
    req.flash('success', `The ${role} role is back to the standard home page.`);
  } catch (err) {
    logger.warn(`[homeLayout] role reset failed: ${err.message}`);
    req.flash('error', 'That layout could not be reset.');
  }
  return res.redirect(`/admin/overviews/home/${role}`);
};

export default { getCustomise, postCustomise, postReset, getRoleDefault, postRoleDefault, postRoleReset, ROLE_CHOICES };
