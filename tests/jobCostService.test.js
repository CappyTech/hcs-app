import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * jobCostService reads mdb.REST lazily inside its functions, so the mdb
 * singleton is patched with plain fakes — no database involved.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import purchaseModel from '../mongoose/models/mongoose/REST/purchase.js';
import {
  roundPence,
  lineNet,
  lineProject,
  isCreditType,
  purchaseSign,
  costLines,
  normaliseProjectNumbers,
  costsPipeline,
  costsFromRows,
  NOT_DELETED,
  purchaseListForProject,
  purchaseCostsByProject,
  purchasesForProject,
  kashflowProjectFigures,
} from '../mongoose/services/jobCostService.js';

const fakeFind = (results) => {
  const q = { select: mock.fn(() => q), lean: mock.fn(() => Promise.resolve(results)) };
  return q;
};

let savedRest;
beforeEach(() => { savedRest = mdb.REST; });
afterEach(() => { mdb.REST = savedRest; });

describe('jobCostService', () => {
  describe('roundPence / lineNet', () => {
    it('rounds to pence, half away from zero', () => {
      assert.equal(roundPence(1.005), 1.01);
      assert.equal(roundPence(-1.005), -1.01);
      assert.equal(roundPence(2.344), 2.34);
      assert.equal(roundPence(0), 0);
      assert.equal(Object.is(roundPence(-0.001), -0), false);
    });

    it('is Quantity × Rate rounded to pence, excluding VAT', () => {
      assert.equal(lineNet({ Quantity: 3, Rate: 15, VATAmount: 9 }), 45);
      assert.equal(lineNet({ Quantity: 0.333, Rate: 10 }), 3.33);
      assert.equal(lineNet({ Quantity: 1.5, Rate: 0.67 }), 1.01); // 1.005
      assert.equal(lineNet({ Quantity: -2, Rate: 12.5 }), -25);
    });

    it('falls back to a line net field when Quantity or Rate is missing', () => {
      assert.equal(lineNet({ Rate: 10, NetAmount: 12.345 }), 12.35);
      assert.equal(lineNet({ Quantity: 2, Net: 7 }), 7);
      assert.equal(lineNet({ Amount: 4.2 }), 4.2);
      assert.equal(lineNet({ Description: 'nothing' }), 0);
      assert.equal(lineNet({ Quantity: '2', Rate: '5' }), 0);
      assert.equal(lineNet(null), 0);
    });

    it('uses HomeCurrencyRate on a foreign-currency purchase', () => {
      const header = { Currency: { Code: 'AUD', ExchangeRate: 2 } };
      assert.equal(lineNet({ Quantity: 3, Rate: 15, HomeCurrencyRate: 7.5 }, header), 22.5);
      assert.equal(lineNet({ Quantity: 3, Rate: 15, HomeCurrencyRate: 7.5 }, { Currency: { ExchangeRate: 1 } }), 45);
      assert.equal(lineNet({ Quantity: 3, Rate: 15 }, header), 45);
    });
  });

  describe('lineProject', () => {
    it("uses the line's ProjectNumber, else the header's", () => {
      assert.equal(lineProject({ ProjectNumber: 41002 }, { ProjectNumber: 41001 }), 41002);
      assert.equal(lineProject({}, { ProjectNumber: 41001 }), 41001);
      assert.equal(lineProject({ ProjectNumber: null }, { ProjectNumber: 41001 }), 41001);
      assert.equal(lineProject({}, {}), null);
    });

    it("keeps a line's 0 (no project) rather than falling back", () => {
      assert.equal(lineProject({ ProjectNumber: 0 }, { ProjectNumber: 41001 }), 0);
    });
  });

  describe('credit notes', () => {
    it('recognises credit and refund types', () => {
      assert.equal(isCreditType({ Type: 'CreditNote' }), true);
      assert.equal(isCreditType({ Type: 'Purchase Credit' }), true);
      assert.equal(isCreditType({ Type: 'Refund' }), true);
      assert.equal(isCreditType({ Type: 'Purchase' }), false);
      assert.equal(isCreditType({}), false);
    });

    it('turns a positive credit note negative', () => {
      const p = { Type: 'CreditNote', NetAmount: 100, ProjectNumber: 41001, LineItems: [{ Quantity: 1, Rate: 100 }] };
      assert.equal(purchaseSign(p), -1);
      assert.deepEqual(costLines(p).map((l) => l.net), [-100]);
    });

    it("leaves a credit note KashFlow already stored negative, so it isn't flipped back", () => {
      const p = { Type: 'CreditNote', NetAmount: -100, ProjectNumber: 41001, LineItems: [{ Quantity: -1, Rate: 100 }] };
      assert.equal(purchaseSign(p), 1);
      assert.deepEqual(costLines(p).map((l) => l.net), [-100]);
    });

    it('flips a credit note with no header total', () => {
      assert.equal(purchaseSign({ Type: 'Refund' }), -1);
    });

    it('counts ordinary purchases as they are', () => {
      assert.equal(purchaseSign({ Type: 'Purchase', NetAmount: 50 }), 1);
      assert.equal(purchaseSign({ NetAmount: -50 }), 1);
    });
  });

  describe('costLines', () => {
    it('gives each line its job, net, description and nominal', () => {
      const p = { ProjectNumber: 41001, LineItems: [
        { Quantity: 2, Rate: 10, Description: 'Timber', NominalCode: 5000 },
        { Quantity: 1, Rate: 5, Description: 'Screws', NominalCode: 5001, ProjectNumber: 41002 },
      ] };
      assert.deepEqual(costLines(p), [
        { project: 41001, net: 20, description: 'Timber', nominal: 5000 },
        { project: 41002, net: 5, description: 'Screws', nominal: 5001 },
      ]);
    });

    it('counts a purchase with no LineItems as one line of its header net', () => {
      assert.deepEqual(costLines({ ProjectNumber: 41001, NetAmount: 99.999, LineItems: [] }), [
        { project: 41001, net: 100, description: '', nominal: null },
      ]);
    });
  });

  describe('normaliseProjectNumbers', () => {
    it('keeps unique positive numbers, accepting strings', () => {
      assert.deepEqual(normaliseProjectNumbers([41001, '41002', 41001, null, 'x', 0, -1]), [41001, 41002]);
      assert.deepEqual(normaliseProjectNumbers(41003), [41003]);
    });
  });

  describe('costsPipeline', () => {
    const pipeline = costsPipeline([41001, 41002]);

    it('matches on a line or header job and leaves deleted purchases out', () => {
      assert.deepEqual(pipeline[0], { $match: { $and: [
        { $or: [{ 'LineItems.ProjectNumber': { $in: [41001, 41002] } }, { ProjectNumber: { $in: [41001, 41002] } }] },
        NOT_DELETED,
      ] } });
      assert.deepEqual(NOT_DELETED, { $nor: [{ DeletedAt: { $type: 'date' } }, { deletedAt: { $type: 'date' } }] });
    });

    it('unwinds lines, keeping purchases with none', () => {
      assert.deepEqual(pipeline[1], { $unwind: { path: '$LineItems', preserveNullAndEmptyArrays: true } });
    });

    it("works out each line's job, line before header, then keeps only the jobs asked for", () => {
      assert.deepEqual(pipeline[2].$addFields._project.$cond[1], { $ifNull: ['$LineItems.ProjectNumber', '$ProjectNumber'] });
      assert.equal(pipeline[2].$addFields._project.$cond[2], '$ProjectNumber');
      assert.deepEqual(pipeline[3], { $match: { _project: { $in: [41001, 41002] } } });
    });

    it('groups per purchase, then per job', () => {
      assert.deepEqual(pipeline[4].$group._id, { project: '$_project', number: '$Number' });
      assert.ok(pipeline[4].$group.net.$sum.$multiply, 'net is a signed, rounded expression');
      assert.deepEqual(pipeline[5], { $group: { _id: '$_id.project', net: { $sum: '$net' }, purchases: { $sum: 1 }, lines: { $sum: '$lines' } } });
      assert.equal(pipeline.length, 6);
    });

    it('signs credit notes with the same pattern as isCreditType', () => {
      const json = JSON.stringify(pipeline[4]);
      assert.match(json, /"regex":"credit\|refund","options":"i"/);
      assert.match(json, /HomeCurrencyRate/);
    });
  });

  describe('costsFromRows', () => {
    it('gives every job asked for an entry, zero when it has nothing', () => {
      const out = costsFromRows([41001, 41002], [
        { _id: 41001, net: 120.004, purchases: 2, lines: 3 },
        { _id: 99999, net: 1, purchases: 1, lines: 1 },
      ]);
      assert.deepEqual([...out.entries()], [
        [41001, { net: 120, purchases: 2, lines: 3 }],
        [41002, { net: 0, purchases: 0, lines: 0 }],
      ]);
    });
  });

  describe('purchaseCostsByProject', () => {
    it('runs one aggregate over all the jobs and maps the rows', async () => {
      const aggregate = mock.fn(async () => [{ _id: 41001, net: -50.5, purchases: 1, lines: 2 }]);
      mdb.REST = { purchase: { aggregate } };
      const out = await purchaseCostsByProject(['41001', 41002, 41001]);
      assert.equal(aggregate.mock.callCount(), 1);
      assert.deepEqual(aggregate.mock.calls[0].arguments[0], costsPipeline([41001, 41002]));
      assert.deepEqual(out.get(41001), { net: -50.5, purchases: 1, lines: 2 });
      assert.deepEqual(out.get(41002), { net: 0, purchases: 0, lines: 0 });
    });

    it("doesn't query for no jobs", async () => {
      const aggregate = mock.fn(async () => []);
      mdb.REST = { purchase: { aggregate } };
      assert.equal((await purchaseCostsByProject([])).size, 0);
      assert.equal(aggregate.mock.callCount(), 0);
    });

    it('throws when the REST model is missing', async () => {
      mdb.REST = {};
      await assert.rejects(purchaseCostsByProject([41001]), /REST purchase model not available/);
    });
  });

  describe('purchaseListForProject / purchasesForProject', () => {
    const purchases = [
      { Number: 10, IssuedDate: new Date('2026-03-01'), SupplierCode: 'TIM01', SupplierName: 'Timber Co', ProjectNumber: 41001,
        LineItems: [
          { Quantity: 2, Rate: 10, Description: 'Joists', NominalCode: 5000 },
          { Quantity: 1, Rate: 30, Description: 'Other job', NominalCode: 5000, ProjectNumber: 41002 },
        ] },
      { Number: 12, IssuedDate: new Date('2026-05-01'), SupplierCode: 'SCR01', SupplierName: 'Screwfix',
        LineItems: [{ Quantity: 3, Rate: 1.115, Description: 'Screws', NominalCode: 5001, ProjectNumber: 41001 }] },
      { Number: 11, IssuedDate: new Date('2026-05-01'), SupplierCode: 'TIM01', SupplierName: 'Timber Co', Type: 'CreditNote', NetAmount: 5,
        LineItems: [{ Quantity: 1, Rate: 5, Description: 'Returned joist', NominalCode: 5000, ProjectNumber: 41001 }] },
      { Number: 13, IssuedDate: new Date('2026-06-01'), SupplierName: 'Elsewhere',
        LineItems: [{ Quantity: 1, Rate: 100, ProjectNumber: 41002 }] },
    ];

    it("lists only the job's lines, newest first, with each purchase's and the job's total", () => {
      const out = purchaseListForProject(41001, purchases);
      assert.deepEqual(out.purchases.map((p) => p.number), [12, 11, 10]);
      assert.deepEqual(out.purchases[2], {
        number: 10, date: new Date('2026-03-01'), supplierCode: 'TIM01', supplierName: 'Timber Co',
        lines: [{ description: 'Joists', net: 20, nominal: 5000 }], net: 20,
      });
      assert.equal(out.purchases[0].net, 3.35); // 3.345 rounded up
      assert.equal(out.purchases[1].net, -5);
      assert.equal(out.net, 18.35);
    });

    it('queries the job by line or header, excluding deleted, and groups the result', async () => {
      const q = fakeFind(purchases);
      const find = mock.fn(() => q);
      mdb.REST = { purchase: { find } };
      const out = await purchasesForProject('41002');
      assert.deepEqual(find.mock.calls[0].arguments[0], {
        $and: [{ $or: [{ 'LineItems.ProjectNumber': 41002 }, { ProjectNumber: 41002 }] }, NOT_DELETED],
      });
      assert.match(q.select.mock.calls[0].arguments[0], /LineItems/);
      assert.deepEqual(out.purchases.map((p) => p.number), [13, 10]);
      assert.equal(out.net, 130);
    });

    it('returns nothing for a missing job number', async () => {
      assert.deepEqual(await purchasesForProject(null), { purchases: [], net: 0 });
    });
  });

  describe('kashflowProjectFigures', () => {
    it("maps KashFlow's actual purchases and sales per project", async () => {
      const q = fakeFind([
        { Number: 41001, ActualPurchasesAmount: 1234.5, ActualSalesAmount: 5000 },
        { Number: 41002, ActualPurchasesAmount: null },
      ]);
      const find = mock.fn(() => q);
      mdb.REST = { project: { find } };
      const out = await kashflowProjectFigures([41001, 41002, 41003]);
      assert.deepEqual(find.mock.calls[0].arguments[0], { $and: [{ Number: { $in: [41001, 41002, 41003] } }, NOT_DELETED] });
      assert.deepEqual(out.get(41001), { actualPurchases: 1234.5, actualSales: 5000 });
      assert.deepEqual(out.get(41002), { actualPurchases: null, actualSales: null });
      assert.equal(out.has(41003), false);
    });

    it("doesn't query for no jobs", async () => {
      mdb.REST = {};
      assert.equal((await kashflowProjectFigures([])).size, 0);
    });
  });

  describe('REST purchase model indexes', () => {
    it('indexes line and header ProjectNumber for the job lookups', () => {
      const keys = purchaseModel.schema.indexes().map(([fields]) => JSON.stringify(fields));
      assert.ok(keys.includes(JSON.stringify({ 'LineItems.ProjectNumber': 1 })));
      assert.ok(keys.includes(JSON.stringify({ ProjectNumber: 1 })));
    });
  });
});
