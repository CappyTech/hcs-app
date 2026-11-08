import path from 'path';
import accessGroups from '../config/accessGroupsConfig.js';
import jobRoleConfig from '../services/jobRoleConfigService.js';
import auditLog from '../../services/auditLogService.js';
import logger from '../../services/loggerService.js';

/**
 * Job role editor (/admin/job-roles, admin only; docs/PERMISSION-GROUPS.md
 * phase 4). Change any job role's name, description, money rule and the
 * level it holds on each area; add job roles; turn one off; reset a built-in
 * role to its default. Every save goes through jobRoleConfigService's
 * validation and applies straight away.
 */

const view = (name) => path.join('tailwindcss', 'admin', 'jobRoles', name);
const on = (v) => v === 'on' || v === '1' || v === 'true' || v === true;
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const back = (slug) => `/admin/job-roles/${encodeURIComponent(slug)}`;

function fail(req, res, err, to) {
  const msg = err instanceof jobRoleConfig.JobRoleError ? err.message : 'That change could not be saved.';
  if (!(err instanceof jobRoleConfig.JobRoleError)) logger.warn(`[jobRoleEditor] ${err?.message || err}`);
  req.flash('error', msg);
  return res.redirect(to);
}

/** Areas in config order, with what the form may offer for each. */
function areaOptions() {
  return Object.entries(accessGroups.groups).map(([key, g]) => ({
    key,
    label: g.label,
    description: g.description,
    levels: accessGroups.LEVELS.slice(0, accessGroups.LEVELS.indexOf(jobRoleConfig.maxLevel(key)) + 1),
    scopable: jobRoleConfig.groupScopable(key),
  }));
}

/** The posted form → a definition for jobRoleConfigService.validate(). */
export function parseForm(body) {
  const level = body.level || {};
  const scope = body.scope || {};
  const money = body.money || {};
  const grants = [];
  for (const key of Object.keys(accessGroups.groups)) {
    const l = str(level[key]);
    if (!l) continue; // "No access"
    grants.push({ group: key, level: l, scope: on(scope[key]) ? 'project' : 'all', values: on(money[key]) });
  }
  return {
    label: str(body.label),
    description: str(body.description),
    values: str(body.values),
    grants,
    disabled: !on(body.enabled),
  };
}

export const getIndex = async (req, res, next) => {
  try {
    const counts = await jobRoleConfig.holders();
    const roles = accessGroups.JOB_ROLE_SLUGS.map((slug) => {
      const def = accessGroups.jobRoles[slug];
      return {
        slug,
        label: def.label,
        description: def.description,
        custom: !accessGroups.defaultJobRoles[slug],
        changed: jobRoleConfig.isChanged(slug) && !!accessGroups.defaultJobRoles[slug],
        disabled: !!def.disabled,
        holders: counts[slug] || 0,
        areas: def.grants.map((g) => `${accessGroups.groups[g.group]?.label || g.group} (${g.level}${g.scope === 'project' ? ', own sites' : ''})`),
      };
    });
    res.render(view('index'), { title: 'Job roles', roles });
  } catch (err) { next(err); }
};

export const getRole = async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const def = accessGroups.jobRoles[slug];
    if (!def) return next();
    const counts = await jobRoleConfig.holders();
    const bySlug = Object.fromEntries(def.grants.map((g) => [g.group, g]));
    res.render(view('edit'), {
      title: `Job role: ${def.label}`,
      slug,
      def,
      grants: bySlug,
      areas: areaOptions(),
      custom: !accessGroups.defaultJobRoles[slug],
      changed: jobRoleConfig.isChanged(slug),
      holders: counts[slug] || 0,
    });
  } catch (err) { next(err); }
};

export const postRole = async (req, res) => {
  const slug = req.params.slug;
  if (!accessGroups.jobRoles[slug]) return fail(req, res, new jobRoleConfig.JobRoleError('There is no such job role.'), '/admin/job-roles');
  try {
    const before = accessGroups.jobRoles[slug];
    const saved = await jobRoleConfig.save(slug, parseForm(req.body), req.user);
    auditLog.record('job_role_changed', req, {
      meta: {
        slug,
        before: { values: before.values, disabled: !!before.disabled, grants: before.grants },
        after: { values: saved.values, disabled: saved.disabled, grants: saved.grants },
      },
    });
    req.flash('success', `Saved ${saved.label}. It applies from everyone's next page.`);
    return res.redirect(back(slug));
  } catch (err) {
    return fail(req, res, err, back(slug));
  }
};

export const postNew = async (req, res) => {
  try {
    const def = await jobRoleConfig.create(str(req.body.label), req.user);
    auditLog.record('job_role_added', req, { meta: { slug: def.slug } });
    req.flash('success', `Added ${def.label}. Give it its areas, then turn it on.`);
    return res.redirect(back(def.slug));
  } catch (err) {
    return fail(req, res, err, '/admin/job-roles');
  }
};

export const postReset = async (req, res) => {
  const slug = req.params.slug;
  const custom = !accessGroups.defaultJobRoles[slug];
  try {
    await jobRoleConfig.reset(slug);
    auditLog.record(custom ? 'job_role_deleted' : 'job_role_reset', req, { meta: { slug } });
    req.flash('success', custom ? 'Job role deleted.' : `${accessGroups.jobRoles[slug].label} is back to its default.`);
    return res.redirect(custom ? '/admin/job-roles' : back(slug));
  } catch (err) {
    return fail(req, res, err, back(slug));
  }
};

export default { getIndex, getRole, postRole, postNew, postReset, parseForm };
