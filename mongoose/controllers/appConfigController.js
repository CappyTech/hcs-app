/**
 * appConfigController — the settings UI, generated from configRegistry.
 *
 * Every page here is rendered from the registry rather than from a hand-written
 * list, which is the point: the four `*_KEYS` arrays this replaces covered 24 of
 * the 122 environment variables the code reads, and nothing ever reconciled the
 * two.
 *
 * The migration story the UI has to tell, per key:
 *   store   — this deployment owns the value; editing it here works, and the
 *             compose.env line (if any) is now dead weight
 *   env     — compose.env supplies it; "Adopt" copies it into the store without
 *             changing the effective value, after which the line can go
 *   default — nothing sets it; saving here sets it for the first time
 */

import path from 'path';
import configService from '../../services/configService.js';
import configStore from '../../services/configStoreService.js';
import registry from '../../services/configRegistry.js';
import logger from '../../services/loggerService.js';

const MASK = '••••••••';

/**
 * Caches that hold a copy of a setting and would otherwise keep serving the old
 * one. Saving a value the running process ignores is the same failure as the
 * `restart: true` keys, only quieter — there is no badge to warn you.
 */
async function runAfterSave(group) {
  if (!group.afterSave) return;
  try {
    if (group.afterSave === 'sms') {
      const smsService = (await import('../../services/smsService.js')).default;
      smsService.resetClient?.();
    } else if (group.afterSave === 'paperless') {
      const paperlessClient = (await import('../services/paperless/paperlessClient.js')).default;
      paperlessClient.invalidateCfCache?.();
    }
  } catch (err) {
    logger.warn(`[appConfig] after-save hook for ${group.id} failed: ${err.message}`);
  }
}

function describeKey(entry) {
  const source = configService.sourceOf(entry.key);
  const raw = configService.get(entry.key, '');
  const isSecret = registry.isSecret(entry.key);
  return {
    ...entry,
    source,
    isSet: raw !== undefined && raw !== '',
    // A secret is never sent to the browser, not even to the admin who set it.
    display: raw === '' || raw === undefined ? '' : isSecret ? MASK : String(raw),
    stored: configStore.has(entry.key),
    // True when compose.env also sets it and the store has taken over: the env
    // line no longer does anything.
    shadowsEnv: configStore.has(entry.key) && Boolean(configService.startupEnvValue(entry.key)),
    adoptable: !configStore.has(entry.key) && Boolean(configService.startupEnvValue(entry.key)),
  };
}

function groupView(group) {
  const fields = group.keys.map(describeKey);
  return {
    ...group,
    fields,
    counts: {
      store: fields.filter((f) => f.source === 'store').length,
      env: fields.filter((f) => f.source === 'env').length,
      unset: fields.filter((f) => !f.isSet).length,
      adoptable: fields.filter((f) => f.adoptable).length,
    },
  };
}

/** Hub: every group, plus how far the compose.env migration has got. */
export const getHub = (req, res, next) => {
  try {
    const groups = registry.GROUPS.map(groupView);
    const bootstrap = registry.BOOTSTRAP_KEYS.map((key) => ({
      key,
      isSet: Boolean(configService.get(key, '')),
      display: /PASS|SECRET|KEY|URI/.test(key)
        ? (configService.get(key, '') ? MASK : '—')
        : (configService.get(key, '') || '—'),
    }));
    res.render(path.join('tailwindcss', 'admin', 'configHub'), {
      title: 'Configuration',
      groups,
      bootstrap,
      pending: configStore.pendingEnvKeys(),
      shadowed: configStore.shadowedEnvKeys(),
    });
  } catch (err) {
    logger.error(`[appConfig] hub error: ${err.message}`);
    next(err);
  }
};

export const getGroup = (req, res, next) => {
  try {
    const group = registry.findGroup(req.params.group);
    if (!group) return res.status(404).render('error', { message: 'No such settings group.' });
    res.render(path.join('tailwindcss', 'admin', 'configGroup'), {
      title: group.label,
      group: groupView(group),
    });
  } catch (err) {
    logger.error(`[appConfig] group error: ${err.message}`);
    next(err);
  }
};

export const postGroup = async (req, res, next) => {
  try {
    const group = registry.findGroup(req.params.group);
    if (!group) return res.status(404).render('error', { message: 'No such settings group.' });

    let saved = 0;
    let restartNeeded = false;
    for (const entry of group.keys) {
      const raw = req.body[entry.key];
      if (raw === undefined) continue;
      const value = String(raw).trim();
      // Blank means "leave as it is". Clearing a value is `Revert`, which is a
      // separate, explicit action — otherwise every save of a form with a
      // masked secret field would wipe the secret.
      if (value === '') continue;
      if (registry.isSecret(entry.key) && value === MASK) continue;
      await configStore.set(entry.key, value, req.session?.user?.username || null);
      saved++;
      if (entry.restart) restartNeeded = true;
    }

    if (saved) {
      await runAfterSave(group);
      logger.info(`[appConfig] ${group.id}: ${saved} setting(s) saved by ${req.session?.user?.username || 'unknown'}`);
      req.flash('success', `Saved ${saved} setting${saved !== 1 ? 's' : ''}.`);
      if (restartNeeded) {
        req.flash('warning', 'One or more of those are read at startup — restart the container for them to take effect.');
      }
    } else {
      req.flash('info', 'No changes — every field was left blank.');
    }
    res.redirect(`/admin/config/${group.id}`);
  } catch (err) {
    logger.error(`[appConfig] save error: ${err.message}`);
    req.flash('error', `Could not save: ${err.message}`);
    res.redirect(`/admin/config/${req.params.group}`);
  }
};

/**
 * Adopt: copy what the environment currently supplies into the store, without
 * changing the effective value. This is the first half of retiring a
 * compose.env line — after it, the line can be deleted at the next deploy and
 * nothing changes.
 */
export const postAdopt = async (req, res, next) => {
  try {
    const group = registry.findGroup(req.params.group);
    if (!group) return res.status(404).render('error', { message: 'No such settings group.' });
    const only = req.body.key ? [req.body.key] : group.keys.map((k) => k.key);
    const adopted = await configStore.adoptFromEnv(only, req.session?.user?.username || null);
    req.flash(
      adopted ? 'success' : 'info',
      adopted
        ? `Adopted ${adopted} setting${adopted !== 1 ? 's' : ''} from the environment. The value has not changed — the compose.env line can now be removed.`
        : 'Nothing to adopt — those settings do not come from the environment.',
    );
    res.redirect(`/admin/config/${group.id}`);
  } catch (err) {
    logger.error(`[appConfig] adopt error: ${err.message}`);
    req.flash('error', `Could not adopt: ${err.message}`);
    res.redirect(`/admin/config/${req.params.group}`);
  }
};

/** Hand a key back to the environment (or to its built-in default). */
export const postRevert = async (req, res, next) => {
  try {
    const group = registry.findGroup(req.params.group);
    const key = req.body.key;
    if (!group || !registry.isManaged(key)) {
      return res.status(404).render('error', { message: 'No such settings group.' });
    }
    await configStore.unset(key);
    const now = configService.sourceOf(key);
    logger.info(`[appConfig] ${key} reverted by ${req.session?.user?.username || 'unknown'}; now sourced from ${now}`);
    req.flash('success', `${key} reverted — it now comes from ${now === 'env' ? 'compose.env' : `its ${now} value`}.`);
    res.redirect(`/admin/config/${group.id}`);
  } catch (err) {
    logger.error(`[appConfig] revert error: ${err.message}`);
    req.flash('error', `Could not revert: ${err.message}`);
    res.redirect(`/admin/config/${req.params.group}`);
  }
};

export default { getHub, getGroup, postGroup, postAdopt, postRevert };
