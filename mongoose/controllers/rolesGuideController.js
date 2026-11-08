import path from 'path';
import guide from '../config/rolesGuideConfig.js';
import accessGroups from '../config/accessGroupsConfig.js';

/**
 * Public /roles article: each role and how it uses the app.
 *
 * Account roles come straight from rolesGuideConfig. Job roles take their
 * label, description and areas from accessGroupsConfig, so adding or changing
 * a grant updates this page with no edit here; rolesGuideConfig only adds the
 * day-to-day prose.
 */

const LEVEL_TEXT = {
  view: 'sees',
  edit: 'works on',
  approve: 'approves',
  manage: 'manages',
};

const VALUES_TEXT = {
  always: 'Sees money — rates, costs and values.',
  never: 'Does not see money — rates, costs and values are hidden.',
  flag: 'Sees money only when "Can see values" is ticked on their account.',
};

/** Job roles in config order, available ones only, ready for the view. */
export function jobRoleEntries() {
  return accessGroups.JOB_ROLE_SLUGS
    .filter(accessGroups.isJobRoleAvailable)
    .map((slug) => {
      const def = accessGroups.jobRoles[slug];
      const areas = def.grants
        .map((g) => {
          const group = accessGroups.groups[g.group];
          if (!group) return null;
          return {
            label: group.label,
            level: g.level,
            levelText: LEVEL_TEXT[g.level] || g.level,
            ownSites: (g.scope || 'all') === 'project',
          };
        })
        .filter(Boolean);
      return {
        id: slug,
        label: def.label,
        summary: def.description,
        uses: guide.jobRoles[slug] || [],
        areas,
        values: VALUES_TEXT[def.values] || null,
      };
    });
}

export function getRolesGuide(req, res) {
  res.render(path.join('tailwindcss', 'roles', 'index'), {
    title: 'Roles',
    guideRoles: guide.roles,
    guideJobRoles: jobRoleEntries(),
    isAuthenticated: !!req.user,
  });
}

export default { getRolesGuide, jobRoleEntries };
