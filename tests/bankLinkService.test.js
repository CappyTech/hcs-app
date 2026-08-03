import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * bankLinkService reads mdb.REST lazily inside its functions, so the mdb
 * singleton can be patched with plain fakes — no database involved.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import {
  classify,
  resolveBankLine,
  buildMatchFromLink,
  signedAmount,
  amountsAgree,
  expectedAllocation,
  bankLineFactHash,
  documentFactHash,
} from '../mongoose/services/bankLinkService.js';

/* ── helpers ──────────────────────────────────────────────────────── */
function fakeFindOne(result) {
  const q = { select() { return q; }, lean() { return Promise.resolve(result); } };
  return q;
}
function fakeFind(results) {
  const q = { select() { return q; }, lean() { return Promise.resolve(results); } };
  return q;
}

function patchMdb({ invoice = null, purchase = null, purchases = [], invoices = [] } = {}) {
  mdb.REST = {
    invoice: {
      findOne: mock.fn(() => fakeFindOne(invoice)),
      find: mock.fn(() => fakeFind(invoices)),
    },
    purchase: {
      findOne: mock.fn(() => fakeFindOne(purchase)),
      find: mock.fn(() => fakeFind(purchases)),
    },
  };
}

const bankTx = (over = {}) => ({
  Id: 47766903,
  AccountId: 611594,
  Date: new Date('2016-10-07T11:00:00Z'),
  EntityName: 'purchase',
  ResourceNumber: 35,
  PaidIn: 0,
  PaidOut: 16.46,
  Comment: 'Purchase - SCRE01',
  ...over,
});

/* ── tests ─────────────────────────────────────────────────────────── */
describe('bankLinkService', () => {
  beforeEach(() => patchMdb());

  describe('signedAmount()', () => {
    it('makes money in positive and money out negative', () => {
      assert.equal(signedAmount({ PaidIn: 100, PaidOut: 0 }), 100);
      assert.equal(signedAmount({ PaidIn: 0, PaidOut: 16.46 }), -16.46);
    });

    it('treats a line with neither as zero', () => {
      assert.equal(signedAmount({}), -0);
      assert.equal(signedAmount({ PaidIn: 0, PaidOut: 0 }), -0);
    });
  });

  describe('amountsAgree()', () => {
    it('tolerates a penny of rounding but not more', () => {
      assert.ok(amountsAgree(100, 100.01));
      assert.ok(!amountsAgree(100, 100.02));
    });
  });

  describe('expectedAllocation()', () => {
    it('inverts the sign for purchases and preserves it for invoices', () => {
      // A purchase payment is money out (negative) against a positive
      // allocation; an invoice receipt is money in against a positive one.
      assert.equal(expectedAllocation(-16.46, 'purchase'), 16.46);
      assert.equal(expectedAllocation(4260, 'invoice'), 4260);
    });

    it('handles refunds, where both signs flip', () => {
      // Supplier refund: credit note with a negative gross, money coming in.
      assert.equal(expectedAllocation(576, 'purchase'), -576);
      // Sales refund: money going back out to a customer.
      assert.equal(expectedAllocation(-430, 'invoice'), -430);
    });
  });

  describe('classify()', () => {
    it('recognises the direct document kinds', () => {
      assert.deepEqual(classify({ EntityName: 'purchase' }), { matchType: 'document', kind: 'purchase', strategy: 'direct' });
      assert.deepEqual(classify({ EntityName: 'invoice' }), { matchType: 'document', kind: 'invoice', strategy: 'direct' });
    });

    it('recognises the batch kinds', () => {
      assert.equal(classify({ EntityName: 'purchasebatchpayment' }).strategy, 'batch');
      assert.equal(classify({ EntityName: 'invoicebatchpayment' }).kind, 'invoice');
    });

    it('treats EntityName banktransaction as unlinked', () => {
      // The 2,547 lines the rules engine and matcher exist for.
      assert.equal(classify({ EntityName: 'banktransaction' }).strategy, 'unlinked');
    });

    it('treats an unknown or missing EntityName as unlinked rather than throwing', () => {
      assert.equal(classify({ EntityName: 'somethingNew' }).strategy, 'unlinked');
      assert.equal(classify({}).strategy, 'unlinked');
      assert.equal(classify(null).strategy, 'unlinked');
    });

    it('is case-insensitive', () => {
      assert.equal(classify({ EntityName: 'Purchase' }).strategy, 'direct');
    });
  });

  describe('resolveBankLine() — direct', () => {
    it('resolves to the document with the matching Number', async () => {
      patchMdb({ purchase: { Id: 900, Number: 35, GrossAmount: 16.46, SupplierName: 'Screwfix', Status: 'Paid' } });
      const r = await resolveBankLine(bankTx());

      assert.equal(r.resolved, true);
      assert.equal(r.matchType, 'document');
      assert.equal(r.documents.length, 1);
      assert.equal(r.documents[0].docKey, 'purchase:900');
      assert.equal(r.documents[0].allocatedAmount, 16.46);
      assert.equal(r.problems.length, 0);
    });

    it('reports a missing document as a problem, not a throw', async () => {
      patchMdb({ purchase: null });
      const r = await resolveBankLine(bankTx());

      assert.equal(r.resolved, false);
      assert.match(r.problems[0], /no longer exists/);
    });

    it('flags an amount mismatch but still resolves', async () => {
      // Normal for part payments and CIS deductions — worth surfacing, not
      // grounds for refusing the link KashFlow itself recorded.
      patchMdb({ purchase: { Id: 900, Number: 35, GrossAmount: 1200 } });
      const r = await resolveBankLine(bankTx({ PaidOut: 960 }));

      assert.equal(r.resolved, true);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /differs from purchase gross/);
    });

    it('reports a missing ResourceNumber', async () => {
      const r = await resolveBankLine(bankTx({ ResourceNumber: 0 }));
      assert.equal(r.resolved, false);
      assert.match(r.problems[0], /ResourceNumber is missing/);
    });

    it('reports an unloaded model rather than throwing', async () => {
      mdb.REST = {};
      const r = await resolveBankLine(bankTx());
      assert.equal(r.resolved, false);
      assert.match(r.problems[0], /model is not loaded/);
    });
  });

  describe('resolveBankLine() — batch fan-out', () => {
    const batchTx = bankTx({
      EntityName: 'purchasebatchpayment',
      ResourceNumber: 12,
      PaidOut: 6458.70,
      Comment: 'Purchase (Batch Payment) #12',
    });

    it('fans out to every document carrying the batch number', async () => {
      patchMdb({
        purchases: [
          { Id: 1, Number: 101, GrossAmount: 3000, PaymentLines: [{ BulkPaymentNumber: 12, Amount: 3000 }] },
          { Id: 2, Number: 102, GrossAmount: 2000, PaymentLines: [{ BulkPaymentNumber: 12, Amount: 2000 }] },
          { Id: 3, Number: 103, GrossAmount: 1458.70, PaymentLines: [{ BulkPaymentNumber: 12, Amount: 1458.70 }] },
        ],
      });
      const r = await resolveBankLine(batchTx);

      assert.equal(r.resolved, true);
      assert.equal(r.matchType, 'batch');
      assert.equal(r.documents.length, 3);
      const total = r.documents.reduce((s, d) => s + d.allocatedAmount, 0);
      assert.ok(Math.abs(total - 6458.70) < 0.01, `allocations summed to ${total}`);
      assert.equal(r.problems.length, 0);
    });

    it('allocates each document its own share, not its gross', async () => {
      // A batch may part-pay an invoice, so the share comes from the payment
      // line, not the document total.
      patchMdb({
        purchases: [
          { Id: 1, Number: 101, GrossAmount: 5000, PaymentLines: [{ BulkPaymentNumber: 12, Amount: 1000 }] },
        ],
      });
      const r = await resolveBankLine(bankTx({ EntityName: 'purchasebatchpayment', ResourceNumber: 12, PaidOut: 1000 }));

      assert.equal(r.documents[0].allocatedAmount, 1000);
      assert.equal(r.documents[0].docGross, 5000);
      assert.equal(r.problems.length, 0);
    });

    it('ignores payment lines belonging to a different batch', async () => {
      patchMdb({
        purchases: [
          { Id: 1, Number: 101, GrossAmount: 3000, PaymentLines: [
            { BulkPaymentNumber: 12, Amount: 1000 },
            { BulkPaymentNumber: 99, Amount: 2000 },
          ] },
        ],
      });
      const r = await resolveBankLine(bankTx({ EntityName: 'purchasebatchpayment', ResourceNumber: 12, PaidOut: 1000 }));
      assert.equal(r.documents[0].allocatedAmount, 1000);
    });

    it('flags allocations that do not sum to the bank amount', async () => {
      patchMdb({
        purchases: [{ Id: 1, Number: 101, GrossAmount: 3000, PaymentLines: [{ BulkPaymentNumber: 12, Amount: 3000 }] }],
      });
      const r = await resolveBankLine(batchTx);

      assert.equal(r.resolved, true);
      assert.match(r.problems[0], /Allocations total 3000\.00 but the bank line implies 6458\.70/);
    });

    it('accepts a supplier refund, where the credit note and bank line are both inverted', async () => {
      // Real case from the live data (bank tx 3653473): purchase 2435 is a
      // credit note with gross -576 and a -576 payment line, settled by 576
      // coming back INTO the account. Comparing absolute values would have
      // called this a mismatch.
      patchMdb({
        purchases: [{ Id: 7, Number: 2435, GrossAmount: -576, Status: 'Paid',
          PaymentLines: [{ BulkPaymentNumber: 93, Amount: -576 }] }],
      });
      const r = await resolveBankLine(bankTx({
        EntityName: 'purchasebatchpayment', ResourceNumber: 93, PaidIn: 576, PaidOut: 0,
      }));

      assert.equal(r.resolved, true);
      assert.equal(r.problems.length, 0, `unexpected problems: ${r.problems.join('; ')}`);
      assert.equal(r.documents[0].allocatedAmount, -576);
    });

    it('still catches a genuinely inverted sign', async () => {
      // An ordinary purchase (positive gross) settled by money coming in is
      // wrong, and must not be waved through by the refund handling above.
      patchMdb({
        purchases: [{ Id: 8, Number: 300, GrossAmount: 500,
          PaymentLines: [{ BulkPaymentNumber: 12, Amount: 500 }] }],
      });
      const r = await resolveBankLine(bankTx({
        EntityName: 'purchasebatchpayment', ResourceNumber: 12, PaidIn: 500, PaidOut: 0,
      }));

      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /implies -500\.00/);
    });

    it('reports a batch number no document carries', async () => {
      patchMdb({ purchases: [] });
      const r = await resolveBankLine(batchTx);
      assert.equal(r.resolved, false);
      assert.match(r.problems[0], /No purchase carries batch payment 12/);
    });
  });

  describe('resolveBankLine() — other kinds', () => {
    it('accounts for journals without needing a document', async () => {
      const r = await resolveBankLine(bankTx({ EntityName: 'journal', ResourceNumber: 486 }));
      assert.equal(r.resolved, true);
      assert.equal(r.matchType, 'journal');
      assert.equal(r.documents.length, 0);
    });

    it('leaves unlinked lines unresolved with no problems recorded', async () => {
      // Not an error — these are simply the matcher's job, not this service's.
      const r = await resolveBankLine(bankTx({ EntityName: 'banktransaction', ResourceNumber: 0 }));
      assert.equal(r.resolved, false);
      assert.equal(r.problems.length, 0);
      assert.equal(r.strategy, 'unlinked');
    });
  });

  describe('buildMatchFromLink()', () => {
    it('builds a suggested match with the bank line and totals', async () => {
      patchMdb({ purchase: { Id: 900, Number: 35, GrossAmount: 16.46, SupplierName: 'Screwfix' } });
      const m = await buildMatchFromLink(bankTx());

      assert.equal(m.status, 'suggested');
      assert.equal(m.origin, 'link');
      assert.equal(m.direction, 'out');
      assert.equal(m.accountId, 611594);
      assert.equal(m.bankLines.length, 1);
      assert.equal(m.bankLines[0].bankTransactionId, 47766903);
      assert.equal(m.bankLines[0].amount, -16.46);
      assert.equal(m.totals.variance, 0);
    });

    it('never auto-confirms, even on a perfect KashFlow link', async () => {
      patchMdb({ purchase: { Id: 900, Number: 35, GrossAmount: 16.46 } });
      const m = await buildMatchFromLink(bankTx());
      assert.equal(m.status, 'suggested');
      assert.notEqual(m.status, 'confirmed');
    });

    it('marks money in as direction "in"', async () => {
      patchMdb({ invoice: { Id: 5, Number: 1521, GrossAmount: 4260, CustomerName: 'Plus Dane' } });
      const m = await buildMatchFromLink(bankTx({ EntityName: 'invoice', ResourceNumber: 1521, PaidIn: 4260, PaidOut: 0 }));
      assert.equal(m.direction, 'in');
      assert.equal(m.totals.bankTotal, 4260);
    });

    it('returns null for a line it cannot resolve', async () => {
      patchMdb({ purchase: null });
      assert.equal(await buildMatchFromLink(bankTx()), null);
    });

    it('records the variance when the amounts differ', async () => {
      patchMdb({ purchase: { Id: 900, Number: 35, GrossAmount: 1200 } });
      const m = await buildMatchFromLink(bankTx({ PaidOut: 960 }));
      assert.equal(m.totals.bankTotal, -960);
      assert.equal(m.totals.documentTotal, 960);
      // Allocation follows the bank line for a direct match, so the document
      // snapshot carries the gross and the discrepancy is visible there.
      assert.equal(m.documents[0].docGross, 1200);
    });
  });

  describe('fact hashes', () => {
    it('are stable for unchanged facts', () => {
      const tx = bankTx();
      assert.equal(bankLineFactHash(tx), bankLineFactHash(bankTx()));
    });

    it('change when the amount changes', () => {
      assert.notEqual(bankLineFactHash(bankTx()), bankLineFactHash(bankTx({ PaidOut: 99 })));
    });

    it('ignore sync churn so an ordinary re-sync does not look like drift', () => {
      const a = documentFactHash({ Id: 1, Number: 2, GrossAmount: 10, Status: 'Paid' });
      const b = documentFactHash({ Id: 1, Number: 2, GrossAmount: 10, Status: 'Paid', syncedAt: new Date(), _kfHash: 'xyz' });
      assert.equal(a, b);
    });

    it('change when the document gross changes', () => {
      const a = documentFactHash({ Id: 1, Number: 2, GrossAmount: 10 });
      const b = documentFactHash({ Id: 1, Number: 2, GrossAmount: 11 });
      assert.notEqual(a, b);
    });
  });
});
