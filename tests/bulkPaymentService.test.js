import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * bulkPaymentService reads mdb.REST lazily and issues KashFlow calls via the
 * kfSession singleton, so both can be patched with plain fakes — no database
 * and no network. The service captured `kfAxios = kfSession.kfAxios` at load,
 * so we mutate that SAME object's .get/.post rather than reassigning it.
 */
import kfSession from '../services/kashflowSessionService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import bulkPay, { outstandingAmount } from '../mongoose/services/bulkPaymentService.js';

// withKfAuth just needs to hand the callback a token.
kfSession.withKfAuth = async (fn) => fn('test-token');

function stubLivePurchases(byNumber) {
  kfSession.kfAxios.get = mock.fn(async (url) => {
    const m = String(url).match(/\/purchases\/(\d+)/);
    const n = m ? Number(m[1]) : null;
    if (n != null && Object.prototype.hasOwnProperty.call(byNumber, n)) {
      return { data: byNumber[n] };
    }
    const err = new Error('Not found');
    err.response = { status: 404 };
    throw err;
  });
}

// Just enough of Mongo's query language to run OUTSTANDING_QUERY over plain docs.
function evalExpr(e, doc) {
  if (typeof e === 'string' && e.startsWith('$')) return doc[e.slice(1)];
  if (e === null || typeof e !== 'object') return e;
  const [[op, args]] = Object.entries(e);
  const v = args.map((a) => evalExpr(a, doc));
  switch (op) {
    case '$gt': return v[0] > v[1];
    case '$or': return v.some(Boolean);
    case '$ifNull': return v[0] ?? v[1];
    case '$subtract': return v[0] - v[1];
    default: throw new Error(`evalExpr: unsupported ${op}`);
  }
}
function matches(query, doc) {
  return Object.entries(query).every(([key, want]) => {
    if (key === '$expr') return evalExpr(want, doc);
    if (key === '$and') return want.every((q) => matches(q, doc));
    if (want === null) return doc[key] == null;
    if (want?.$nin) return !want.$nin.includes(doc[key]);
    return doc[key] === want;
  });
}
function fakePurchases(docs) {
  const found = (q) => docs.filter((d) => matches(q, d));
  const chain = (rows) => ({
    select: () => chain(rows), sort: () => chain(rows), skip: () => chain(rows), limit: () => chain(rows), lean: async () => rows,
  });
  return {
    countDocuments: async (q) => found(q).length,
    find: (q) => chain(found(q)),
    aggregate: async ([{ $match }]) => {
      const rows = found($match);
      return rows.length ? [{ _id: { id: rows[0].SupplierId, name: rows[0].SupplierName, code: rows[0].SupplierCode }, count: rows.length }] : [];
    },
  };
}

describe('bulkPaymentService', () => {
  describe('outstandingAmount', () => {
    it('does not believe a DueAmount of 0 on an unpaid purchase', () => {
      assert.equal(outstandingAmount({ DueAmount: 0, GrossAmount: 200, TotalPaidAmount: 0, Status: 'Unpaid' }), 200);
    });
    it('takes off part payments when DueAmount is 0', () => {
      assert.equal(outstandingAmount({ DueAmount: 0, GrossAmount: 200, TotalPaidAmount: 75, Status: 'Unpaid' }), 125);
    });
    it('is zero once paid or cancelled, whatever the amounts say', () => {
      assert.equal(outstandingAmount({ DueAmount: 0, GrossAmount: 200, TotalPaidAmount: 0, Status: 'Paid' }), 0);
      assert.equal(outstandingAmount({ DueAmount: 50, GrossAmount: 200, TotalPaidAmount: 150, Status: 'Paid' }), 0);
      assert.equal(outstandingAmount({ DueAmount: 0, GrossAmount: 200, TotalPaidAmount: 0, Status: 'Cancelled' }), 0);
    });
    it('prefers DueAmount when present', () => {
      assert.equal(outstandingAmount({ DueAmount: 120.5, GrossAmount: 200, TotalPaidAmount: 50 }), 120.5);
    });
    it('falls back to gross minus paid', () => {
      assert.equal(outstandingAmount({ GrossAmount: 200, TotalPaidAmount: 75 }), 125);
    });
    it('is zero for a null doc', () => {
      assert.equal(outstandingAmount(null), 0);
    });
  });

  describe('listOutstanding', () => {
    const base = { SupplierId: 9, SupplierName: 'Acme', SupplierCode: 'ACM', GrossAmount: 200, TotalPaidAmount: 0, DueAmount: 0, Status: 'Unpaid' };
    const docs = [
      { ...base, Number: 201 },                                      // the bug: unpaid, DueAmount 0
      { ...base, Number: 202, TotalPaidAmount: 50 },                 // part paid, DueAmount 0
      { ...base, Number: 203, DueAmount: 120 },                      // DueAmount filled in
      { ...base, Number: 204, DueAmount: undefined },                // predates DueAmount
      { ...base, Number: 205, TotalPaidAmount: 200 },                // paid in full, status lagging
      { ...base, Number: 206, Status: 'Paid' },                      // paid, amounts not filled in
      { ...base, Number: 207, Status: 'Cancelled' },
      { ...base, Number: 208, GrossAmount: -30 },                    // credit note
      { ...base, Number: 209, deletedAt: new Date('2026-01-01') },   // gone from KashFlow
    ];

    beforeEach(() => { mdb.REST = { purchase: fakePurchases(docs) }; });

    it('lists unpaid purchases whose DueAmount is 0, and nothing settled', async () => {
      const r = await bulkPay.listOutstanding();
      assert.deepEqual(r.rows.map((d) => [d.Number, d.outstanding]), [[201, 200], [202, 150], [203, 120], [204, 200]]);
      assert.equal(r.total, 4);
    });

    it('offers suppliers whose only unpaid purchases have a DueAmount of 0', async () => {
      mdb.REST = { purchase: fakePurchases([{ ...base, Number: 201 }]) };
      const [s] = await bulkPay.listOutstandingSuppliers();
      assert.equal(s?.SupplierCode, 'ACM');
      assert.equal(s?.count, 1);
    });
  });

  describe('reverify', () => {
    beforeEach(() => {
      stubLivePurchases({
        101: { Id: 1, Number: 101, DueAmount: 300, GrossAmount: 300, Status: 'Unpaid', SupplierName: 'Acme', SupplierId: 9, SupplierCode: 'ACM' },
        102: { Id: 2, Number: 102, DueAmount: 0, GrossAmount: 500, Status: 'Paid', SupplierName: 'Beta' },
        103: { Id: 3, Number: 103, DueAmount: 40, GrossAmount: 40, Status: 'Unpaid', SupplierName: 'Gamma' },
        104: { Id: 4, Number: 104, DueAmount: 0, GrossAmount: 250, TotalPaidAmount: 0, Status: 'Unpaid', SupplierName: 'Delta' },
        105: { Id: 5, Number: 105, DueAmount: 0, GrossAmount: 250, TotalPaidAmount: 200, Status: 'Unpaid', SupplierName: 'Delta' },
        106: { Id: 6, Number: 106, DueAmount: 0, GrossAmount: 250, TotalPaidAmount: 250, Status: 'Unpaid', SupplierName: 'Delta' },
      });
    });

    it('passes a payable line and totals only payable lines', async () => {
      const r = await bulkPay.reverify([{ number: 101, amount: 300 }]);
      assert.equal(r.ok, true);
      assert.equal(r.blocking, 0);
      assert.equal(r.total, 300);
      assert.equal(r.lines[0].supplierName, 'Acme');
    });

    it('blocks an already-settled invoice', async () => {
      const r = await bulkPay.reverify([{ number: 102, amount: 100 }]);
      assert.equal(r.lines[0].ok, false);
      assert.match(r.lines[0].problem, /already settled/i);
      assert.equal(r.blocking, 1);
      assert.equal(r.total, 0);
    });

    it('lets an unpaid purchase through when KashFlow says DueAmount 0', async () => {
      const r = await bulkPay.reverify([{ number: 104, amount: 250 }]);
      assert.equal(r.ok, true);
      assert.equal(r.lines[0].liveDueAmount, 250);
      assert.equal(r.total, 250);
    });

    it('still caps a part-paid purchase at what is left when DueAmount is 0', async () => {
      const r = await bulkPay.reverify([{ number: 105, amount: 60 }]);
      assert.equal(r.lines[0].ok, false);
      assert.match(r.lines[0].problem, /exceeds the 50\.00/);
    });

    it('still blocks a purchase paid in full when DueAmount is 0', async () => {
      const r = await bulkPay.reverify([{ number: 106, amount: 10 }]);
      assert.equal(r.lines[0].ok, false);
      assert.match(r.lines[0].problem, /already settled/i);
    });

    it('blocks an amount over what is now due', async () => {
      const r = await bulkPay.reverify([{ number: 103, amount: 60 }]);
      assert.equal(r.lines[0].ok, false);
      assert.match(r.lines[0].problem, /exceeds/i);
    });

    it('blocks a purchase that no longer exists', async () => {
      const r = await bulkPay.reverify([{ number: 999, amount: 10 }]);
      assert.equal(r.lines[0].ok, false);
      assert.match(r.lines[0].problem, /no longer exists/i);
    });

    it('rejects a non-positive amount without calling KashFlow', async () => {
      const r = await bulkPay.reverify([{ number: 101, amount: 0 }]);
      assert.equal(r.lines[0].ok, false);
      assert.match(r.lines[0].problem, /greater than zero/i);
    });

    it('reports mixed batches as not-all-ok with the right total', async () => {
      const r = await bulkPay.reverify([
        { number: 101, amount: 300 },
        { number: 102, amount: 100 },
      ]);
      assert.equal(r.ok, false);        // one line blocked
      assert.equal(r.blocking, 1);
      assert.equal(r.total, 300);       // only the payable line counts
    });
  });

  describe('createBulkPayment', () => {
    it('POSTs a well-formed BulkPayment_Create payload', async () => {
      let captured = null;
      kfSession.kfAxios.post = mock.fn(async (url, payload) => {
        captured = { url, payload };
        return { data: { Number: 777 } };
      });

      const res = await bulkPay.createBulkPayment({
        accountId: 55,
        date: '2026-09-02',
        method: 5,
        comment: 'September run',
        lines: [
          { number: 101, Id: 1, requestedAmount: 300, supplierId: 9, supplierCode: 'ACM', supplierName: 'Acme' },
          { number: 103, Id: 3, requestedAmount: 40, supplierName: 'Gamma' },
        ],
      });

      assert.equal(res.ok, true);
      assert.equal(res.bulkPaymentNumber, 777);
      assert.match(captured.url, /\/purchases\/bulk\/payments$/);
      assert.equal(captured.payload.AccountId, 55);
      assert.equal(captured.payload.Method, 5);
      assert.equal(captured.payload.Date, '2026-09-02');
      assert.equal(captured.payload.Comment, 'September run');
      assert.equal(captured.payload.PaymentItems.length, 2);

      const first = captured.payload.PaymentItems[0];
      assert.equal(first.ObjectNumber, 101);
      assert.equal(first.Amount, 300);
      assert.equal(first.PaidDate, '2026-09-02');
      assert.equal(first.Id, 1);
      assert.equal(first.ContactId, 9);
      assert.equal(first.ContactCode, 'ACM');
    });
  });
});
