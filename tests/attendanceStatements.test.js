const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// ── Stubs ────────────────────────────────────────────────────────────────────

/** Build a chainable Mongoose query stub: .find().select().populate().lean() */
function fakeQuery(docs) {
  const q = {
    _docs: docs,
    select() { return q; },
    populate() { return q; },
    sort() { return q; },
    lean() { return Promise.resolve(q._docs); },
    then(resolve, reject) { return Promise.resolve(q._docs).then(resolve, reject); },
  };
  return q;
}

/**
 * Patch mdb with mock model factories before requiring
 * any module that uses mongooseDatabaseService.
 */
const mdb = require('../mongoose/services/mongooseDatabaseService');

function stubModels({ ocrDocs = [], purchases = [], suppliers = [] } = {}) {
  mdb.PAPERLESS = {
    OcrDocument: {
      find: mock.fn(() => fakeQuery(ocrDocs)),
      findOne: mock.fn(() => fakeQuery(ocrDocs[0] || null)),
      updateOne: mock.fn(() => Promise.resolve({ modifiedCount: 1 })),
    },
  };
  mdb.REST = {
    purchase: {
      find: mock.fn(() => fakeQuery(purchases)),
      findOne: mock.fn((filter) => {
        const num = filter?.Number;
        const found = purchases.find(p => String(p.Number) === String(num));
        return fakeQuery(found || null);
      }),
    },
    supplier: {
      find: mock.fn(() => fakeQuery(suppliers)),
    },
  };
}

// Require the service AFTER patching mdb so it picks up our stubs
const {
  fetchStatementsForWeek,
} = require('../mongoose/services/attendanceServicesMongoose');
const attendanceController = require('../mongoose/controllers/attendanceController');

const moment = require('moment');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOcrStatement(paperlessId, invoiceNumberValue, opts = {}) {
  return {
    paperlessId,
    title: opts.title || `Statement ${paperlessId}`,
    documentType: { id: 1, name: 'statement' },
    correspondent: opts.correspondent || { id: 1, name: 'Test Supplier' },
    modified: opts.modified || new Date('2026-03-23'),
    customFields: [
      { fieldId: 1, fieldName: 'Invoice Number', value: invoiceNumberValue },
      ...(opts.invoiceTotal != null
        ? [{ fieldId: 2, fieldName: 'Invoice Total', value: opts.invoiceTotal }]
        : []),
    ],
  };
}

function makePurchase(Number, opts = {}) {
  return {
    uuid: opts.uuid || `purchase-uuid-${Number}`,
    Number: String(Number),
    SupplierId: opts.SupplierId ?? 100,
    SupplierName: opts.SupplierName || 'Test Supplier',
    SupplierReference: opts.SupplierReference || `REF-${Number}`,
    GrossAmount: opts.GrossAmount ?? 120,
    NetAmount: opts.NetAmount ?? 100,
    TotalPaidAmount: opts.TotalPaidAmount ?? 120,
    PaidDate: opts.PaidDate || null,
    DueDate: opts.DueDate || null,
    deletedAt: opts.deletedAt || null,
  };
}

function makeSupplier(Id, opts = {}) {
  return {
    Id,
    Name: opts.Name || `Supplier ${Id}`,
    Code: opts.Code || `SUP${Id}`,
    Contacts: opts.Contacts || [
      { Name: 'John', Telephone: '01onal', Mobile: '07123456', Email: 'john@example.com' },
    ],
    Address: opts.Address || { Line1: '1 High St', PostCode: 'AB1 2CD' },
  };
}

/** Minimal Express-like req mock */
function mockReq(overrides = {}) {
  const flashes = {};
  return {
    params: {},
    body: {},
    flash(type, msg) {
      if (msg === undefined) return flashes[type] || [];
      flashes[type] = flashes[type] || [];
      flashes[type].push(msg);
    },
    _flashes: flashes,
    ...overrides,
  };
}

/** Minimal Express-like res mock */
function mockRes() {
  const res = {
    _status: 200,
    _redirected: null,
    status(code) { res._status = code; return res; },
    redirect(url) { res._redirected = url; },
    json(data) { res._json = data; },
    render(view, data) { res._view = view; res._data = data; },
  };
  return res;
}

// ── fetchStatementsForWeek ───────────────────────────────────────────────────

describe('fetchStatementsForWeek', () => {
  it('returns empty array when PAPERLESS namespace is unavailable', async () => {
    mdb.PAPERLESS = null;
    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.deepEqual(result, []);
  });

  it('returns empty array when OcrDocument model is unavailable', async () => {
    mdb.PAPERLESS = {};
    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.deepEqual(result, []);
  });

  it('returns empty array when no statements match the week', async () => {
    stubModels({ ocrDocs: [] });
    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.deepEqual(result, []);
  });

  it('parses comma-separated invoice numbers from custom field', async () => {
    const stmt = makeOcrStatement(10, '101, 102, 103');
    stubModels({ ocrDocs: [stmt], purchases: [] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].invoiceNumbers, ['101', '102', '103']);
  });

  it('handles single invoice number without commas', async () => {
    const stmt = makeOcrStatement(10, '501');
    stubModels({ ocrDocs: [stmt], purchases: [] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.deepEqual(result[0].invoiceNumbers, ['501']);
  });

  it('handles empty invoice number field gracefully', async () => {
    const stmt = makeOcrStatement(10, '');
    stubModels({ ocrDocs: [stmt] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.deepEqual(result[0].invoiceNumbers, []);
    assert.deepEqual(result[0].purchases, undefined); // no purchases looked up
  });

  it('parses statement total from "GBP108.93" format', async () => {
    const stmt = makeOcrStatement(10, '101', { invoiceTotal: 'GBP108.93' });
    stubModels({ ocrDocs: [stmt], purchases: [] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].statementTotal, 108.93);
  });

  it('parses statement total from plain number string', async () => {
    const stmt = makeOcrStatement(10, '101', { invoiceTotal: '250.00' });
    stubModels({ ocrDocs: [stmt], purchases: [] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].statementTotal, 250);
  });

  it('defaults statement total to 0 when field is missing', async () => {
    const stmt = makeOcrStatement(10, '101');
    stubModels({ ocrDocs: [stmt], purchases: [] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].statementTotal, 0);
  });

  it('matches purchases by invoice number', async () => {
    const stmt = makeOcrStatement(10, '101, 102');
    const p1 = makePurchase('101', { GrossAmount: 100, TotalPaidAmount: 100 });
    const p2 = makePurchase('102', { GrossAmount: 200, TotalPaidAmount: 50 });
    stubModels({ ocrDocs: [stmt], purchases: [p1, p2] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].purchases.length, 2);
    assert.equal(result[0].purchases[0].Number, '101');
    assert.equal(result[0].purchases[1].Number, '102');
  });

  it('identifies missing invoice numbers', async () => {
    const stmt = makeOcrStatement(10, '101, 999');
    const p1 = makePurchase('101');
    stubModels({ ocrDocs: [stmt], purchases: [p1] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.deepEqual(result[0].missingNumbers, ['999']);
  });

  it('computes totalGross and totalPaid from matched purchases', async () => {
    const stmt = makeOcrStatement(10, '101, 102');
    const p1 = makePurchase('101', { GrossAmount: 100, TotalPaidAmount: 80 });
    const p2 = makePurchase('102', { GrossAmount: 200, TotalPaidAmount: 200 });
    stubModels({ ocrDocs: [stmt], purchases: [p1, p2] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].totalGross, 300);
    assert.equal(result[0].totalPaid, 280);
    assert.equal(result[0].totalOutstanding, 20);
  });

  it('resolves supplier from first matched purchase SupplierId', async () => {
    const stmt = makeOcrStatement(10, '101');
    const p1 = makePurchase('101', { SupplierId: 42 });
    const sup = makeSupplier(42, { Name: 'Acme Ltd' });
    stubModels({ ocrDocs: [stmt], purchases: [p1], suppliers: [sup] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].supplier.Name, 'Acme Ltd');
    assert.equal(result[0].supplier.Id, 42);
  });

  it('sets supplier to null when no purchases match', async () => {
    const stmt = makeOcrStatement(10, '999');
    stubModels({ ocrDocs: [stmt], purchases: [] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result[0].supplier, null);
  });

  it('handles multiple statements with different suppliers', async () => {
    const stmt1 = makeOcrStatement(10, '101');
    const stmt2 = makeOcrStatement(20, '201');
    const p1 = makePurchase('101', { SupplierId: 1 });
    const p2 = makePurchase('201', { SupplierId: 2 });
    const s1 = makeSupplier(1, { Name: 'Supplier A' });
    const s2 = makeSupplier(2, { Name: 'Supplier B' });
    stubModels({ ocrDocs: [stmt1, stmt2], purchases: [p1, p2], suppliers: [s1, s2] });

    const result = await fetchStatementsForWeek(
      moment('2026-03-21'), moment('2026-03-27')
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].supplier.Name, 'Supplier A');
    assert.equal(result[1].supplier.Name, 'Supplier B');
  });
});

// ── purchaseStatementMap construction ────────────────────────────────────────

describe('purchaseStatementMap construction', () => {
  // Extract the same logic used in the controller
  function buildPurchaseStatementMap(statements) {
    const purchaseStatementMap = {};
    for (const entry of statements) {
      const pid = entry.statement?.paperlessId;
      if (!pid) continue;
      for (const p of entry.purchases || []) {
        if (p.uuid) purchaseStatementMap[p.uuid] = pid;
      }
    }
    return purchaseStatementMap;
  }

  it('maps purchase uuids to their statement paperlessId', () => {
    const statements = [
      {
        statement: { paperlessId: 10 },
        purchases: [
          { uuid: 'aaa', Number: '101' },
          { uuid: 'bbb', Number: '102' },
        ],
      },
    ];
    const map = buildPurchaseStatementMap(statements);
    assert.equal(map['aaa'], 10);
    assert.equal(map['bbb'], 10);
  });

  it('handles multiple statements', () => {
    const statements = [
      { statement: { paperlessId: 10 }, purchases: [{ uuid: 'aaa', Number: '101' }] },
      { statement: { paperlessId: 20 }, purchases: [{ uuid: 'bbb', Number: '201' }] },
    ];
    const map = buildPurchaseStatementMap(statements);
    assert.equal(map['aaa'], 10);
    assert.equal(map['bbb'], 20);
  });

  it('returns empty map for empty statements', () => {
    assert.deepEqual(buildPurchaseStatementMap([]), {});
  });

  it('skips entries with no paperlessId', () => {
    const statements = [
      { statement: {}, purchases: [{ uuid: 'aaa' }] },
    ];
    const map = buildPurchaseStatementMap(statements);
    assert.deepEqual(map, {});
  });

  it('skips purchases without uuid', () => {
    const statements = [
      { statement: { paperlessId: 10 }, purchases: [{ Number: '101' }] },
    ];
    const map = buildPurchaseStatementMap(statements);
    assert.deepEqual(map, {});
  });

  it('skips entries with no purchases array', () => {
    const statements = [{ statement: { paperlessId: 10 } }];
    const map = buildPurchaseStatementMap(statements);
    assert.deepEqual(map, {});
  });
});

// ── addStatementPurchase ─────────────────────────────────────────────────────

describe('addStatementPurchase', () => {
  beforeEach(() => {
    stubModels();
  });

  it('rejects empty purchase number', async () => {
    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});
    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.error[0].includes('required'));
  });

  it('rejects whitespace-only purchase number', async () => {
    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '   ' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});
    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.error[0].includes('required'));
  });

  it('rejects purchase number that does not exist in REST', async () => {
    stubModels({ purchases: [] });
    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '999' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});
    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.error[0].includes('not found'));
  });

  it('rejects when statement document is not found', async () => {
    const p = makePurchase('101');
    stubModels({ purchases: [p], ocrDocs: [] });
    // findOne returns null for missing doc
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(null));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '101' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});
    assert.equal(res._status, 404);
    assert.equal(res._redirected, 'back');
  });

  it('rejects when document is not a statement type', async () => {
    const p = makePurchase('101');
    const doc = { paperlessId: 10, documentType: { name: 'invoice' }, customFields: [] };
    stubModels({ purchases: [p], ocrDocs: [doc] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(doc));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '101' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});
    assert.equal(res._status, 404);
  });

  it('rejects duplicate purchase number', async () => {
    const p = makePurchase('101');
    const doc = makeOcrStatement(10, '101');
    stubModels({ purchases: [p], ocrDocs: [doc] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(doc));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '101' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});
    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.error[0].includes('already'));
  });

  it('adds purchase number and updates MongoDB', async () => {
    const p = makePurchase('102');
    const doc = makeOcrStatement(10, '101');
    stubModels({ purchases: [p], ocrDocs: [doc] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(doc));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '102' } });
    const res = mockRes();
    await attendanceController.addStatementPurchase(req, res, () => {});

    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.success[0].includes('102'));
    // Verify updateOne was called
    assert.equal(mdb.PAPERLESS.OcrDocument.updateOne.mock.calls.length, 1);
    const updateArgs = mdb.PAPERLESS.OcrDocument.updateOne.mock.calls[0].arguments;
    assert.equal(updateArgs[0].paperlessId, 10);
    assert.ok(updateArgs[1].$set['customFields.$.value'].includes('102'));
  });
});

// ── removeStatementPurchase ──────────────────────────────────────────────────

describe('removeStatementPurchase', () => {
  beforeEach(() => {
    stubModels();
  });

  it('rejects empty purchase number', async () => {
    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '' } });
    const res = mockRes();
    await attendanceController.removeStatementPurchase(req, res, () => {});
    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.error[0].includes('required'));
  });

  it('returns 404 when statement not found', async () => {
    stubModels({ ocrDocs: [] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(null));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '101' } });
    const res = mockRes();
    await attendanceController.removeStatementPurchase(req, res, () => {});
    assert.equal(res._status, 404);
    assert.equal(res._redirected, 'back');
  });

  it('rejects when purchase number is not on statement', async () => {
    const doc = makeOcrStatement(10, '101, 102');
    stubModels({ ocrDocs: [doc] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(doc));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '999' } });
    const res = mockRes();
    await attendanceController.removeStatementPurchase(req, res, () => {});
    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.error[0].includes('not on this statement'));
  });

  it('removes purchase number and updates MongoDB', async () => {
    const doc = makeOcrStatement(10, '101, 102, 103');
    stubModels({ ocrDocs: [doc] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(doc));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '102' } });
    const res = mockRes();
    await attendanceController.removeStatementPurchase(req, res, () => {});

    assert.equal(res._redirected, 'back');
    assert.ok(req._flashes.success[0].includes('102'));
    assert.equal(mdb.PAPERLESS.OcrDocument.updateOne.mock.calls.length, 1);
    const csv = mdb.PAPERLESS.OcrDocument.updateOne.mock.calls[0].arguments[1].$set['customFields.$.value'];
    assert.ok(csv.includes('101'));
    assert.ok(csv.includes('103'));
    assert.ok(!csv.includes('102'));
  });

  it('removes the only purchase number leaving empty value', async () => {
    const doc = makeOcrStatement(10, '101');
    stubModels({ ocrDocs: [doc] });
    mdb.PAPERLESS.OcrDocument.findOne = mock.fn(() => fakeQuery(doc));

    const req = mockReq({ params: { paperlessId: '10' }, body: { purchaseNumber: '101' } });
    const res = mockRes();
    await attendanceController.removeStatementPurchase(req, res, () => {});

    assert.equal(res._redirected, 'back');
    const csv = mdb.PAPERLESS.OcrDocument.updateOne.mock.calls[0].arguments[1].$set['customFields.$.value'];
    assert.equal(csv, '');
  });
});
