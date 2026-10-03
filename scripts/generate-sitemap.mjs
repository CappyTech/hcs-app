/**
 * Generates a sitemap of every route hcs-app serves: method, path, who can
 * open it, and the route file that declares it.
 *
 *   npm run sitemap                      # writes docs/SITEMAP.md and docs/sitemap.json
 *   npm run sitemap -- --check           # exit 1 if those files are out of date
 *   node scripts/generate-sitemap.mjs --out <dir>   # write somewhere else
 *
 * Routes are read from Express's own route tables rather than from the source
 * text, so the generated CRUD and list routes are included exactly as the app
 * registers them. No database is needed: models are registered on unconnected
 * Mongoose connections, which is enough for the CRUD and list controllers to
 * generate their handlers.
 *
 * Access comes from three places, applied in the same order as a request:
 *   1. isPublicPath() — ensureAuthenticated lets these through without a login
 *   2. routeAccess    — the global ensureRouteAccess guard (longest prefix)
 *   3. the `__access` label authService puts on each per-route guard
 * Custom per-user grants are not shown: they widen access for one user only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = path.join(APP, 'mongoose/routes');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const outArg = argv.indexOf('--out');
const OUT_DIR = outArg !== -1 ? path.resolve(argv[outArg + 1]) : path.join(APP, 'docs');

// Routers app.js mounts somewhere other than '/', only under a condition, and
// ahead of appRouter — so the login and routeAccess guards never run for them.
const SPECIAL_MOUNTS = {
  devDbRoutes: { prefix: '/admin/db', condition: 'Development only (DEV_DB_ADMIN=true, loopback)', outsideAppRouter: true },
  setupRoutes: { prefix: '/setup', condition: 'First run only, before the app is configured', outsideAppRouter: true },
};

// ── 1. Register models so the generated routes exist ─────────────────
// Some modules refuse to load without these. Nothing here encrypts or signs
// anything, so a placeholder is enough when the real values are not set.
process.env.ENCRYPTION_KEY ||= 'sitemap-generator-placeholder';
process.env.SESSION_SECRET ||= 'sitemap-generator-placeholder';

// Loading every model and controller logs a line each at debug level.
const { default: logger } = await import('../services/loggerService.js');
logger.level = 'warn';

const { default: mdb, loadNamespaceModels } = await import('../mongoose/services/mongooseDatabaseService.js');
for (const ns of ['REST', 'INTERNAL', 'PAPERLESS', 'WEB']) {
  await loadNamespaceModels(ns, mongoose.createConnection());
}

const { default: rbac } = await import('../mongoose/config/rolePermissionsConfig.js');
const { isPublicPath } = await import('../services/authService.js');
const ALL_ROLES = Object.keys(rbac.roleDepartments);

// ── 2. Load every router ─────────────────────────────────────────────
const appSource = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
const warnings = [];
const routes = [];

for (const file of files) {
  const name = file.replace(/\.js$/, '');
  const router = (await import(pathToFileURL(path.join(ROUTES_DIR, file)).href)).default;
  if (!router?.stack) {
    warnings.push(`${file} does not export an Express router`);
    continue;
  }
  if (!appSource.includes(`/routes/${file}`)) warnings.push(`${file} is not imported by app.js`);
  const mount = SPECIAL_MOUNTS[name] || { prefix: '' };
  collect(router, name, mount);
}

function collect(router, source, mount) {
  const routerGuards = []; // router.use() middleware applies to every route after it
  for (const layer of router.stack) {
    if (!layer.route) {
      if (layer.name === 'router') {
        warnings.push(`${source}.js mounts a nested router; its routes are not listed`);
      } else {
        routerGuards.push(layer.handle);
      }
      continue;
    }
    const paths = [].concat(layer.route.path);
    const handlers = layer.route.stack.map((l) => l.handle);
    const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all').map((m) => m.toUpperCase());
    for (const p of paths) {
      if (typeof p !== 'string') {
        warnings.push(`${source}.js has a regular-expression route (${p}); not listed`);
        continue;
      }
      const fullPath = (mount.prefix + (p === '/' && mount.prefix ? '' : p)) || '/';
      for (const method of methods) {
        routes.push({
          method,
          path: fullPath,
          ...(mount.outsideAppRouter
            ? { access: 'public', roles: [] }
            : resolveAccess(fullPath, [...routerGuards, ...handlers])),
          source: `${source}.js`,
          ...(mount.condition ? { condition: mount.condition } : {}),
        });
      }
    }
  }
}

function resolveAccess(routePath, handlers) {
  if (isPublicPath(routePath)) return { access: 'public', roles: [] };

  let roles = [...ALL_ROLES];
  const matched = rbac.matchRoutePattern(routePath);
  if (matched) roles = roles.filter((r) => rbac.canAccessRoute(r, matched, {}));

  for (const fn of handlers) {
    const a = fn?.__access;
    if (!a) continue;
    if (a.roles) roles = roles.filter((r) => a.roles.includes(r));
    if (a.model) roles = roles.filter((r) => rbac.canAccess(r, a.model, a.operation, {}).allowed);
    if (a.department) roles = roles.filter((r) => rbac.canAccessDepartment(r, a.department, {}));
  }
  if (roles.length === ALL_ROLES.length) return { access: 'signed-in', roles };
  return { access: roles.length ? 'roles' : 'nobody', roles };
}

// ── 3. Tidy and check ────────────────────────────────────────────────
const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
routes.sort((a, b) =>
  a.path.localeCompare(b.path, 'en', { sensitivity: 'base' }) ||
  METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method));

// Same method and path declared twice: Express serves whichever was mounted
// first, so the other is unreachable unless the first calls next('route').
const seen = new Map();
for (const r of routes) {
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) warnings.push(`${key} is declared in both ${seen.get(key)} and ${r.source}`);
  else seen.set(key, r.source);
}

// ── 4. Render ────────────────────────────────────────────────────────
// No version or date in the output: --check compares byte for byte, and either
// would make the committed files stale on every release.
const json = JSON.stringify({ roles: ALL_ROLES, routes, warnings }, null, 2) + '\n';

function who(r) {
  if (r.access === 'public') return 'Public';
  if (r.access === 'signed-in') return 'Any signed-in user';
  if (r.access === 'nobody') return 'Nobody (admin custom grants only)';
  return r.roles.join(', ');
}
function section(p) {
  const first = p.split('/')[1] || '';
  return first === '' || first.startsWith(':') ? '/' : `/${first}`;
}

const groups = new Map();
for (const r of routes) {
  const s = section(r.path);
  if (!groups.has(s)) groups.set(s, []);
  groups.get(s).push(r);
}

const pages = routes.filter((r) => r.method === 'GET').length;
const md = [
  '# hcs-app sitemap',
  '',
  'Generated by `npm run sitemap` from the routes Express registers. Do not edit by hand.',
  '',
  `${routes.length} routes: ${pages} pages (GET) and ${routes.length - pages} actions that change data.`,
  '"Who can open" is by role, before any per-user custom grants; admin can always open everything.',
  'It says who can reach a page, not which rows they see: list and record pages still limit some roles',
  'to their own records (rolePermissionsConfig `:own` scopes).',
  '',
  ...(warnings.length ? ['## Warnings', '', ...warnings.map((w) => `- ${w}`), ''] : []),
  ...[...groups].flatMap(([name, rs]) => [
    `## ${name}`,
    '',
    '| Method | Path | Who can open | Declared in |',
    '|---|---|---|---|',
    ...rs.map((r) => `| ${r.method} | \`${r.path}\` | ${who(r)}${r.condition ? `. ${r.condition}` : ''} | ${r.source} |`),
    '',
  ]),
].join('\n');

const outputs = { 'SITEMAP.md': md, 'sitemap.json': json };

if (CHECK) {
  const stale = Object.entries(outputs).filter(([f, body]) => {
    const p = path.join(OUT_DIR, f);
    return !fs.existsSync(p) || fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') !== body;
  });
  if (stale.length) {
    console.error(`Out of date: ${stale.map(([f]) => f).join(', ')}. Run npm run sitemap.`);
    process.exit(1);
  }
  console.log('Sitemap is up to date.');
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [f, body] of Object.entries(outputs)) fs.writeFileSync(path.join(OUT_DIR, f), body);
  console.log(`Wrote ${routes.length} routes to ${path.relative(APP, OUT_DIR) || '.'}/SITEMAP.md and sitemap.json`);
  for (const w of warnings) console.warn(`warning: ${w}`);
}

// Route modules start timers and the database service registers exit hooks;
// none of that is wanted here.
process.exit(0);
