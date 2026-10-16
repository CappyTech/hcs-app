import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, buildFilter, routeAllows, normaliseQuery, escapeRegex, ENTITIES, MAX_QUERY_LENGTH } from '../mongoose/services/searchService.js';

/**
 * Database-wide search: the term becomes the list pages' own type-aware
 * filter, only entities the role may list (and the read route admits) are
 * searched, ownership scoping is ANDed in, and each group is capped.
 */

// A fake Mongoose model: schema paths with instances, and a chainable find()
function fakeModel(paths, docs) {
  const calls = [];
  return {
    calls,
    schema: { path: (p) => (paths[p] ? { instance: paths[p] } : undefined) },
    find(filter) {
      const call = { filter };
      calls.push(call);
      const chain = {
        sort(s) { call.sort = s; return chain; },
        limit(n) { call.limit = n; return chain; },
        lean() { return chain; },
        maxTimeMS(ms) { call.maxTimeMS = ms; return chain; },
        then(resolve, reject) { return Promise.resolve(docs.slice(0, call.limit)).then(resolve, reject); },
      };
      return chain;
    },
  };
}

const quiet = { warn() {}, info() {} };

describe('searchService', () => {
  describe('buildFilter', () => {
    const model = { schema: { path: (p) => ({ Number: { instance: 'Number' }, Name: { instance: 'String' }, Note: { instance: 'Mixed' } })[p] } };

    it('regex on strings, exact on numbers, both when the term is numeric', () => {
      const f = buildFilter(model, ['Number', 'Name'], '42');
      assert.equal(f.$or.length, 2);
      assert.deepEqual(f.$or[0], { Number: 42 });
      assert.ok(f.$or[1].Name instanceof RegExp);
      assert.ok(f.$or[1].Name.test('order 42 for acme'));
      assert.equal(f.$or[1].Name.flags, 'i');
    });

    it('skips numeric fields for a non-numeric term and escapes regex metacharacters', () => {
      const f = buildFilter(model, ['Number', 'Name'], 'a.b (c)');
      assert.equal(f.$or.length, 1);
      assert.ok(f.$or[0].Name.test('A.B (C) ltd'));
      assert.ok(!f.$or[0].Name.test('axb (c)'));
    });

    it('treats unknown and mixed paths as strings, and returns null with nothing to match', () => {
      assert.equal(buildFilter(model, ['Note', 'correspondent.name'], 'x').$or.length, 2);
      assert.equal(buildFilter(model, ['Number'], 'abc'), null);
    });
  });

  describe('routeAllows', () => {
    it('mirrors the CRUD read middleware strings', () => {
      assert.equal(routeAllows('accountant', ['ensureRoles:admin,accountant']), true);
      assert.equal(routeAllows('employee', ['ensureRoles:admin,accountant']), false);
      assert.equal(routeAllows('employee', ['ensureRole:admin']), false);
      assert.equal(routeAllows('admin', ['ensureRole:admin']), true);
      assert.equal(routeAllows('client', ['ensureAuthenticated', 'ensureDepartment:finance']), true);
      assert.equal(routeAllows('client', []), false);
    });
  });

  describe('normaliseQuery / escapeRegex', () => {
    it('trims, collapses whitespace and caps length', () => {
      assert.equal(normaliseQuery('  acme   ltd \n'), 'acme ltd');
      assert.equal(normaliseQuery('x'.repeat(500)).length, MAX_QUERY_LENGTH);
      assert.equal(normaliseQuery(undefined), '');
      assert.equal(escapeRegex('a+b'), 'a\\+b');
    });
  });

  describe('registry', () => {
    it('every entity has the fields a hit needs and a unique key', () => {
      const keys = new Set();
      for (const e of ENTITIES) {
        assert.ok(!keys.has(e.key), `duplicate key ${e.key}`); keys.add(e.key);
        assert.ok(['INTERNAL', 'REST', 'PAPERLESS'].includes(e.ns), e.key);
        assert.ok(Array.isArray(e.fields) && e.fields.length, e.key);
        assert.equal(typeof e.title, 'function', e.key);
        assert.equal(typeof e.href, 'function', e.key);
        assert.ok(e.list && e.list.startsWith('/'), e.key);
      }
    });
  });

  describe('search', () => {
    const customers = [{ uuid: 'c1', Name: 'Acme Builders', Code: 'ACM' }, { uuid: 'c2', Name: 'Acme Roofing', Code: 'ACR' }, { uuid: 'c3', Name: 'Acme Glass', Code: 'ACG' }];
    const invoices = [{ uuid: 'i1', Number: 42, CustomerName: 'Acme Builders' }];
    function env({ role = 'admin', scope = {}, canList = () => true, dept = () => true } = {}) {
      const customer = fakeModel({ Name: 'String', Code: 'String' }, customers);
      const invoice = fakeModel({ Number: 'Number', CustomerName: 'String' }, invoices);
      const document = fakeModel({ title: 'String' }, [{ paperlessId: 9, title: 'Acme statement' }]);
      const db = { REST: { customer, invoice }, INTERNAL: {}, PAPERLESS: { OcrDocument: document } };
      const access = {
        canAccess: (r, model, op) => ({ allowed: canList(model, op), ownOnly: false }),
        canAccessDepartment: (r, d) => dept(d),
      };
      const entities = ENTITIES.filter((e) => ['customer', 'invoice', 'document'].includes(e.key));
      const svc = createSearch({ db, access, scopeQuery: async () => scope, logger: quiet, entities, middlewareFor: () => ['ensureRoles:admin,accountant'] });
      return { svc, customer, invoice, document, req: { user: { role, customPermissions: {} } } };
    }

    it('returns grouped, capped hits with links, and flags when there is more', async () => {
      const { svc, customer, req } = env();
      const r = await svc.search(req, 'acme', { limit: 2 });
      assert.equal(r.q, 'acme');
      const c = r.groups.find((g) => g.key === 'customer');
      assert.equal(c.items.length, 2);
      assert.equal(c.more, true);
      assert.deepEqual(c.items[0], { title: 'Acme Builders', subtitle: 'ACM', href: '/customer/read/c1' });
      assert.equal(customer.calls[0].limit, 3);
      assert.equal(customer.calls[0].maxTimeMS, 3000);
      const inv = r.groups.find((g) => g.key === 'invoice');
      assert.equal(inv.items[0].title, 'Invoice 42');
      assert.equal(inv.more, false);
    });

    it('narrows to one type and uses the larger limit', async () => {
      const { svc, customer, req } = env();
      const r = await svc.search(req, 'acme', { type: 'customer', limit: 50 });
      assert.equal(r.groups.length, 1);
      assert.equal(r.groups[0].items.length, 3);
      assert.equal(customer.calls[0].limit, 51);
    });

    it('ANDs the ownership scope into every query', async () => {
      const { svc, customer, req } = env({ role: 'accountant', scope: { CustomerId: 7 } });
      await svc.search(req, 'acme');
      assert.deepEqual(Object.keys(customer.calls[0].filter), ['$and']);
      assert.deepEqual(customer.calls[0].filter.$and[0], { CustomerId: 7 });
    });

    it('skips entities the role may not list, that the read route refuses, or whose department gate fails', async () => {
      const a = env({ role: 'accountant', canList: (m) => m !== 'invoice' });
      const ra = await a.svc.search(a.req, 'acme');
      assert.deepEqual(ra.groups.map((g) => g.key).sort(), ['customer', 'document']);
      assert.equal(a.invoice.calls.length, 0);

      const b = env({ role: 'employee' });
      const rb = await b.svc.search(b.req, 'acme');
      assert.deepEqual(rb.groups.map((g) => g.key), ['document']);

      const c = env({ role: 'admin', dept: () => false });
      const rc = await c.svc.search(c.req, 'acme');
      assert.ok(!rc.groups.some((g) => g.key === 'document'));
      assert.equal(c.document.calls.length, 0);
    });

    it('skips an entity whose scope resolves to null and one with no signed-in user', async () => {
      const svcNull = createSearch({ db: { REST: { customer: fakeModel({ Name: 'String' }, customers) }, INTERNAL: {}, PAPERLESS: {} }, access: { canAccess: () => ({ allowed: true }), canAccessDepartment: () => true }, scopeQuery: async () => null, logger: quiet, entities: ENTITIES.filter((e) => e.key === 'customer') }).search;
      assert.deepEqual((await svcNull({ user: { role: 'client' } }, 'acme')).groups, []);
      const { svc } = env();
      assert.deepEqual((await svc.search({}, 'acme')).groups, []);
    });

    it('rejects short terms without querying, and survives one failing collection', async () => {
      const { svc, customer, req } = env();
      const short = await svc.search(req, 'a');
      assert.equal(short.tooShort, true);
      assert.equal(customer.calls.length, 0);

      const broken = { schema: { path: () => ({ instance: 'String' }) }, find() { throw new Error('boom'); } };
      const svc2 = createSearch({ db: { REST: { customer: broken, invoice: fakeModel({ Number: 'Number' }, invoices) }, INTERNAL: {}, PAPERLESS: {} }, access: { canAccess: () => ({ allowed: true }), canAccessDepartment: () => true }, scopeQuery: async () => ({}), logger: quiet, entities: ENTITIES.filter((e) => ['customer', 'invoice'].includes(e.key)), middlewareFor: () => [] }).search;
      const r = await svc2(req, '42');
      assert.deepEqual(r.groups.map((g) => g.key), ['invoice']);
    });
  });
});
