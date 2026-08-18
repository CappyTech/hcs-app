import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import tilesConfig from '../mongoose/config/dashboardTilesConfig.js';
import webContentConfig from '../mongoose/config/webContentConfig.js';

/**
 * Config-consistency checks for the website content editor. No database, no
 * HTTP — the same shape as bankRoutesGuards.test.js, and for the same reason:
 * what publishes to the public internet is decided across a routes file, an
 * RBAC config, a department registry and a content config, and the failure mode
 * of those disagreeing is silent.
 *
 * The checks that matter most here are the two about the *public* API: it is
 * the only route surface in this app that answers without a session, so the
 * things keeping it safe — a token, GET-only, no broader public prefix — are
 * pinned rather than left to review.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const webRoutesSrc = read('mongoose/routes/webRoutes.js');
const apiRoutesSrc = read('mongoose/routes/webApiRoutes.js');
const apiCtrlSrc = read('mongoose/controllers/webApiController.js');
const authSrc = read('services/authService.js');
const controllerSrc = read('mongoose/controllers/webController.js');

/** Every route webRoutes.js registers: method, path, and the guard named first. */
function declaredRoutes(src) {
  const re = /router\.(get|post)\(\s*'([^']+)'\s*,\s*(\.\.\.)?(\w+)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ method: m[1], path: m[2], guard: m[4] });
  }
  return out;
}

describe('website editor routes / permissions consistency', () => {
  const routes = declaredRoutes(webRoutesSrc);

  it('registers the expected surface', () => {
    const paths = routes.map((r) => r.path);
    for (const expected of [
      '/website/settings',
      '/website/media',
      '/website/media/:uuid/file',
      '/website/:type',
      '/website/:type/create',
      '/website/:type/:uuid/edit',
      '/website/:type/:uuid/publish',
      '/website/:type/:uuid/unpublish',
      '/website/:type/:uuid/delete',
    ]) {
      assert.ok(paths.includes(expected), `missing route ${expected}`);
    }
  });

  it('guards every editor route with adminOnly', () => {
    for (const r of routes) {
      assert.equal(r.guard, 'adminOnly', `${r.method.toUpperCase()} ${r.path} is not admin-guarded`);
    }
  });

  it('registers the singleton and media routes before the generic :type routes', () => {
    // Express matches in declaration order. '/website/settings' would otherwise
    // be swallowed by '/website/:type' and resolve as a content type named
    // "settings" — which exists, and would render a list page for a singleton.
    const genericIdx = webRoutesSrc.indexOf("router.get('/website/:type'");
    for (const specific of ["router.get('/website/settings'", "router.get('/website/media'"]) {
      const idx = webRoutesSrc.indexOf(specific);
      assert.ok(idx > -1 && idx < genericIdx, `${specific} must be registered before /website/:type`);
    }
  });

  it('validates CSRF after multer on the media upload', () => {
    // The global CSRF middleware cannot read a multipart body, so validation
    // has to run again once multer has parsed it — after, never before, or it
    // reads an empty body and rejects every upload.
    const uploadArray = controllerSrc.match(/export const postMediaUpload = \[([\s\S]*?)\]/);
    assert.ok(uploadArray, 'postMediaUpload middleware array not found');
    const body = uploadArray[1];
    const multerIdx = body.indexOf("upload.single('image')");
    const csrfIdx = body.indexOf('csrfService.validate');
    assert.ok(multerIdx > -1, 'no multer middleware on the upload');
    assert.ok(csrfIdx > -1, 'no CSRF validation on the upload');
    assert.ok(multerIdx < csrfIdx, 'csrfService.validate must run AFTER multer');
  });

  it("routeAccess grants '/website' to admin only", () => {
    const matched = rbac.matchRoutePattern('/website/case-studies');
    assert.equal(matched, '/website');
    assert.ok(rbac.canAccessRoute('admin', matched, {}));
    for (const role of ['accountant', 'employee', 'subcontractor', 'client', 'hmrc', 'auditor', 'none']) {
      assert.ok(!rbac.canAccessRoute(role, matched, {}), `${role} can reach /website`);
    }
  });

  it('has a website department that only admin can open', () => {
    assert.ok(departmentsConfig.website, 'no website department');
    assert.deepEqual(departmentsConfig.website.roles, ['admin']);
  });

  it('points every website dashboard tile at a route that exists', () => {
    // The 6.26.0 changelog records a tile that advertised a 404 for months
    // because the link and the route are declared in different files.
    const tiles = Object.values(tilesConfig).filter((t) => (t.department || []).includes('website'));
    assert.ok(tiles.length >= 5, `only ${tiles.length} website tiles`);
    const types = Object.keys(webContentConfig);
    for (const tile of tiles) {
      const segment = tile.link.replace('/website/', '');
      const known = segment === 'media' || segment === 'settings' || types.includes(segment);
      assert.ok(known, `tile "${tile.title}" links to ${tile.link}, which no route serves`);
    }
  });
});

describe('public website content API', () => {
  const routes = declaredRoutes(apiRoutesSrc);

  it('is GET-only', () => {
    // A POST here would inherit the PUBLIC_PREFIXES bypass below while having
    // no CSRF protection, since this router deliberately carries none.
    assert.ok(routes.length > 0, 'no API routes found');
    for (const r of routes) {
      assert.equal(r.method, 'get', `${r.path} is not a GET`);
    }
  });

  it('requires the bearer token on every route', () => {
    for (const r of routes) {
      const line = apiRoutesSrc.split('\n').find((l) => l.includes(`'${r.path}'`));
      assert.match(line, /requireWebApiToken/, `${r.path} has no token guard`);
    }
  });

  it('rate-limits every route', () => {
    for (const r of routes) {
      const line = apiRoutesSrc.split('\n').find((l) => l.includes(`'${r.path}'`));
      assert.match(line, /webApiLimiter/, `${r.path} is not rate-limited`);
    }
  });

  it('fails closed when WEB_API_TOKEN is unset', () => {
    // An unconfigured deployment must refuse, not serve. A 200 to the whole
    // internet is the outcome this asserts against.
    assert.match(apiCtrlSrc, /if \(!expected\)[\s\S]{0,200}res\.status\(503\)/);
  });

  it('only ever exposes published records', () => {
    assert.match(apiCtrlSrc, /status: 'published'/, 'media route does not filter on status');
  });

  it("makes '/api/web/' public and nothing broader", () => {
    // Anything under this prefix skips ensureAuthenticated. The 6.x incident
    // recorded in authService.js was a prefix one segment too short.
    assert.ok(authSrc.includes('"/api/web/"'), 'the API prefix is not public');
    assert.ok(!authSrc.includes('"/api/"'), '"/api/" would expose every API route');
  });
});
