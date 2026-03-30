const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

/*
 * dataScopingService requires rbac at top-level (pure config, use as-is)
 * and mdb lazily inside scopeQuery(). Patch the mdb singleton.
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');
const { scopeQuery, scopeQueryOrError } = require('../services/dataScopingService');

/* ── helpers ──────────────────────────────────────────────────────── */
function fakeQuery(result = null) {
  const q = {
    select() { return q; },
    lean() { return Promise.resolve(result); },
  };
  return q;
}

function makeReq(overrides = {}) {
  return { user: { role: 'admin', customPermissions: {}, ...overrides } };
}

function patchMdb({ suppliers = {}, customers = {}, employee = null } = {}) {
  mdb.REST = {
    supplier: { findById: mock.fn((id) => Promise.resolve(suppliers[id] || null)) },
    customer: { findById: mock.fn((id) => Promise.resolve(customers[id] || null)) },
  };
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    employee: { findById: mock.fn(() => fakeQuery(employee)) },
  };
}

/* ── tests ─────────────────────────────────────────────────────────── */
describe('dataScopingService', () => {
  beforeEach(() => patchMdb());

  describe('scopeQuery', () => {
    it('returns null when req.user is missing', async () => {
      assert.equal(await scopeQuery({}, 'invoice'), null);
    });

    it('returns {} for admin role', async () => {
      assert.deepStrictEqual(await scopeQuery(makeReq(), 'invoice'), {});
    });

    it('returns null for role "none" (no access)', async () => {
      // role none has no model access in rbac config
      assert.equal(await scopeQuery(makeReq({ role: 'none' }), 'invoice'), null);
    });

    it('returns {} for accountant (read+list access, no ownership scope)', async () => {
      const result = await scopeQuery(makeReq({ role: 'accountant' }), 'invoice');
      assert.deepStrictEqual(result, {});
    });

    it('returns {} for hmrc role reading supplier', async () => {
      const result = await scopeQuery(makeReq({ role: 'hmrc' }), 'supplier');
      assert.deepStrictEqual(result, {});
    });

    it('returns null for hmrc role on non-permitted model', async () => {
      const result = await scopeQuery(makeReq({ role: 'hmrc' }), 'invoice');
      assert.equal(result, null);
    });

    it('builds ownership filter for employee attendance (ownOnly)', async () => {
      patchMdb();
      const req = makeReq({ role: 'employee', employeeId: 'emp123' });
      const result = await scopeQuery(req, 'attendance');
      assert.deepStrictEqual(result, { employeeId: 'emp123' });
    });

    it('builds SupplierId filter for subcontractor purchase', async () => {
      patchMdb({ suppliers: { sub1: { Id: 42, Code: 'SUP42' } } });
      const req = makeReq({ role: 'subcontractor', subcontractorId: 'sub1' });
      const result = await scopeQuery(req, 'purchase');
      assert.deepStrictEqual(result, { SupplierId: 42 });
    });

    it('builds CustomerId filter for client invoice', async () => {
      patchMdb({ customers: { cli1: { Id: 77, Code: 'CLI77' } } });
      const req = makeReq({ role: 'client', clientId: 'cli1' });
      const result = await scopeQuery(req, 'invoice');
      assert.deepStrictEqual(result, { CustomerId: 77 });
    });

    it('builds CustomerCode filter for client project', async () => {
      patchMdb({ customers: { cli1: { Id: 77, Code: 'ABC' } } });
      const req = makeReq({ role: 'client', clientId: 'cli1' });
      const result = await scopeQuery(req, 'project');
      assert.deepStrictEqual(result, { CustomerCode: 'ABC' });
    });

    it('returns null when linked supplier not found', async () => {
      patchMdb(); // no suppliers
      const req = makeReq({ role: 'subcontractor', subcontractorId: 'missing' });
      const result = await scopeQuery(req, 'purchase');
      assert.equal(result, null);
    });

    it('returns null when employee has no employeeId', async () => {
      patchMdb();
      const req = makeReq({ role: 'employee' }); // no employeeId
      const result = await scopeQuery(req, 'attendance');
      assert.equal(result, null);
    });

    it('extends filter with IR35 dual-role $or when employee has ir35', async () => {
      patchMdb({
        employee: { ir35: true, subcontractorSupplierId: 'suppId99' },
        suppliers: { suppId99: { Id: 55 } },
      });
      const req = makeReq({ role: 'employee', employeeId: 'emp1' });
      const result = await scopeQuery(req, 'attendance');
      // Primary filter: { employeeId: 'emp1' }
      // Secondary (IR35 subcontractor): { subcontractorId: 'suppId99' }
      assert.deepStrictEqual(result, { $or: [{ employeeId: 'emp1' }, { subcontractorId: 'suppId99' }] });
    });

    it('skips IR35 when employee lacks ir35 flag', async () => {
      patchMdb({ employee: { ir35: false } });
      const req = makeReq({ role: 'employee', employeeId: 'emp1' });
      const result = await scopeQuery(req, 'attendance');
      assert.deepStrictEqual(result, { employeeId: 'emp1' });
    });

    it('accepts custom operation parameter', async () => {
      // accountant has 'r,l' on invoice — 'u' (update) should be denied
      const result = await scopeQuery(makeReq({ role: 'accountant' }), 'invoice', 'u');
      assert.equal(result, null);
    });
  });

  describe('scopeQueryOrError', () => {
    it('resolves with filter for admin', async () => {
      assert.deepStrictEqual(await scopeQueryOrError(makeReq(), 'invoice'), {});
    });

    it('throws 401 when user is missing', async () => {
      await assert.rejects(
        () => scopeQueryOrError({}, 'invoice'),
        (err) => { assert.equal(err.statusCode, 401); return true; }
      );
    });

    it('throws 403 when role has no access', async () => {
      await assert.rejects(
        () => scopeQueryOrError(makeReq({ role: 'none' }), 'invoice'),
        (err) => { assert.equal(err.statusCode, 403); return true; }
      );
    });
  });
});
