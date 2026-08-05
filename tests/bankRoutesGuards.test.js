import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rbac from '../mongoose/config/rolePermissionsConfig.js';

/**
 * Config-consistency checks for the bank module. No database, no HTTP.
 *
 * These exist because access control here is enforced in two places — the
 * global ensureRouteAccess middleware driven by routeAccess, and the per-route
 * guards in bankRoutes.js — and the two disagreeing silently is the failure
 * mode worth catching.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesSrc = fs.readFileSync(path.join(ROOT, 'mongoose/routes/bankRoutes.js'), 'utf8');

/** Every path bankRoutes.js registers, with its HTTP method and guard name. */
function declaredRoutes() {
  const re = /router\.(get|post)\(\s*'([^']+)'\s*,\s*\.\.\.(\w+)/g;
  const out = [];
  let m;
  while ((m = re.exec(routesSrc)) !== null) {
    out.push({ method: m[1], path: m[2], guard: m[3] });
  }
  return out;
}

describe('bank routes / permissions consistency', () => {
  const routes = declaredRoutes();

  it('registers the expected surface', () => {
    assert.ok(routes.length >= 12, `only found ${routes.length} bank routes`);
    const paths = routes.map(r => r.path);
    for (const expected of [
      '/bank',
      '/bank/exceptions',
      '/bank/accounts/:accountId',
      // The account is part of the line's identity: an internal transfer is two
      // ledger lines sharing one KashFlow Id.
      '/bank/lines/:bankAccountId/:bankTransactionId',
      '/bank/matches/:uuid/confirm',
      '/bank/signoff',
      '/bank/statements',
      '/bank/statements/upload',
    ]) {
      assert.ok(paths.includes(expected), `missing route ${expected}`);
    }
  });

  it('validates CSRF after multer on the statement upload', () => {
    // The global CSRF middleware runs before the multipart body is parsed, so
    // it sees no token on this request. Validation has to run again once
    // multer has populated req.body — and after, never before, or it reads an
    // empty body and rejects every upload.
    const upload = routesSrc.match(/router\.post\(\s*'\/bank\/statements\/upload'[\s\S]*?\);/);
    assert.ok(upload, 'upload route not found');

    const body = upload[0];
    const multerAt = body.indexOf('statementUpload.single');
    const csrfAt = body.indexOf('csrfService.validate');

    assert.ok(multerAt > -1, 'upload route does not use multer');
    assert.ok(csrfAt > -1, 'upload route does not re-validate CSRF');
    assert.ok(csrfAt > multerAt, 'csrfService.validate must come after multer');
  });

  it('puts every bank route under a routeAccess entry', () => {
    for (const route of routes) {
      const pattern = rbac.matchRoutePattern(route.path.replace(/:[^/]+/g, 'x'));
      assert.ok(pattern, `no routeAccess pattern covers ${route.path}`);
      assert.ok(pattern.startsWith('/bank'), `${route.path} matched unrelated pattern ${pattern}`);
    }
  });

  it('grants bank access to admin and accountant only', () => {
    const allowed = rbac.routeAccess['/bank'];
    assert.deepEqual([...allowed].sort(), ['accountant', 'admin']);
  });

  it('declares no :param routeAccess patterns for /bank, which could never match', () => {
    // matchRoutePattern is literal longest-prefix with no :param support, so
    // such a pattern would read as protection while matching nothing.
    //
    // Scoped to /bank deliberately: '/paperless/ocr/:paperlessId' is an
    // existing entry with this problem, which is a separate pre-existing issue
    // and not this module's to fix.
    for (const pattern of Object.keys(rbac.routeAccess)) {
      if (!pattern.startsWith('/bank')) continue;
      assert.ok(!pattern.includes(':'), `routeAccess pattern "${pattern}" contains a :param and can never match`);
    }
  });

  it('guards the two destructive actions with the admin-only guard', () => {
    // These undo something a reviewer has already signed their name to, and
    // routeAccess cannot express them (see above), so the route guard is the
    // only thing enforcing it.
    const byPath = Object.fromEntries(routes.map(r => [r.path, r]));
    assert.equal(byPath['/bank/matches/:uuid/unconfirm']?.guard, 'adminGuard');
    assert.equal(byPath['/bank/signoff/:uuid/reopen']?.guard, 'adminGuard');
  });

  it('guards every other bank route with the finance guard', () => {
    const adminOnly = new Set(['/bank/matches/:uuid/unconfirm', '/bank/signoff/:uuid/reopen']);
    for (const route of routes) {
      if (adminOnly.has(route.path)) continue;
      assert.equal(route.guard, 'bankGuard', `${route.path} uses ${route.guard}`);
    }
  });

  it('gives accountants read access to the bank models and no writes', () => {
    // canAccess returns { allowed, ownOnly } — truthy either way, so the
    // .allowed unwrap matters.
    for (const model of ['bankAccount', 'bankTransaction', 'bankReconciliation', 'bankMatch', 'bankSignOff']) {
      assert.equal(rbac.canAccess('accountant', model, 'r').allowed, true, `accountant cannot read ${model}`);
      assert.equal(rbac.canAccess('accountant', model, 'l').allowed, true, `accountant cannot list ${model}`);
      // Matches and sign-offs are created through /bank, which validates
      // allocations and prevents double-claims — never the generic CRUD routes.
      assert.equal(rbac.canAccess('accountant', model, 'c').allowed, false, `accountant can create ${model}`);
      assert.equal(rbac.canAccess('accountant', model, 'u').allowed, false, `accountant can update ${model}`);
      assert.equal(rbac.canAccess('accountant', model, 'd').allowed, false, `accountant can delete ${model}`);
    }
  });

  it('does not expose bank data to non-finance roles', () => {
    for (const role of ['employee', 'subcontractor']) {
      assert.equal(rbac.canAccessRoute(role, '/bank'), false, `${role} can reach /bank`);
      assert.equal(rbac.canAccess(role, 'bankTransaction', 'r').allowed, false, `${role} can read bankTransaction`);
      assert.equal(rbac.canAccess(role, 'bankMatch', 'l').allowed, false, `${role} can list bankMatch`);
    }
  });
});
