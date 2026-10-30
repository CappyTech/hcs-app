import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import sift from 'sift';

import cisCheck from '../mongoose/services/paperless/cisCheckService.js';
import queues from '../mongoose/services/paperless/documentQueueService.js';
import cisMappings from '../mongoose/config/cisMappings.js';

const require = createRequire(import.meta.url);
const ejs = require('ejs');

const { kashflowCisDeduction, compareCis, cisAtSend, checkSentCis, refreshCisCheck, cisAtSendByPurchaseId } = cisCheck;

/** Our CIS deduction, kept at send, against the one added by hand in KashFlow. */

const SI = { id: 3, name: 'Subcontractor Invoice' };
const PI = { id: 1, name: 'Purchase Invoice' };
const CIS_TYPE = cisMappings.chargeTypes.cisDeduction;
const CIS_NOMINAL = cisMappings.cisDeductionNominalCodes[0];

const purchase = (id, lines) => ({ Id: id, Number: id + 1000, LineItems: lines });
const labourLine = { Description: 'Labour', NetAmount: 1000, ChargeType: cisMappings.chargeTypes.labour };

/** A model over rows that answers find/findOne/updateOne the way the service uses them. */
function fakeModel(rows) {
  const query = (filter, one) => {
    let out = rows.filter(sift(filter));
    const chain = {
      sort() { return chain; },
      limit(n) { out = out.slice(0, n); return chain; },
      select() { return chain; },
      lean: async () => structuredClone(one ? out[0] ?? null : out),
    };
    return chain;
  };
  return {
    rows,
    find: (f) => query(f, false),
    findOne: (f) => query(f, true),
    async updateOne(filter, { $set }) {
      const row = rows.find(sift(filter));
      if (row) Object.assign(row, structuredClone($set));
    },
  };
}

describe('kashflowCisDeduction', () => {
  it('adds up the CIS lines, by charge type or nominal, as a positive amount', () => {
    assert.equal(kashflowCisDeduction(purchase(1, [labourLine, { NetAmount: -200, ChargeType: CIS_TYPE }])), 200);
    assert.equal(kashflowCisDeduction(purchase(1, [{ NetAmount: -150.5, NominalCode: CIS_NOMINAL }, { Quantity: 1, Rate: -49.5, ChargeType: CIS_TYPE }])), 200);
  });

  it('is null when the purchase has no CIS line', () => {
    assert.equal(kashflowCisDeduction(purchase(1, [labourLine])), null);
    assert.equal(kashflowCisDeduction({}), null);
  });
});

describe('compareCis', () => {
  const ours = { deduction: 200 };

  it('matches to the penny', () => {
    assert.deepEqual(compareCis(ours, purchase(1, [{ NetAmount: -200, ChargeType: CIS_TYPE }])), { status: 'matches', kashflow: 200, difference: 0 });
  });

  it('gives the difference, KashFlow less ours', () => {
    assert.deepEqual(compareCis(ours, purchase(1, [{ NetAmount: -199.99, ChargeType: CIS_TYPE }])), { status: 'differs', kashflow: 199.99, difference: -0.01 });
  });

  it('takes the deduction rounded down to the penny as a match too (HMRC sets no rounding)', () => {
    const sent = { labour: 1234.58, ratePct: 20, deduction: 246.92 };
    const kf = (amount) => compareCis(sent, purchase(1, [{ NetAmount: -amount, ChargeType: CIS_TYPE }]));
    assert.deepEqual(kf(246.91), { status: 'matches', kashflow: 246.91, difference: 0 });
    assert.equal(kf(246.92).status, 'matches');
    assert.deepEqual(kf(246.90), { status: 'differs', kashflow: 246.9, difference: -0.02 });
    assert.equal(kf(246.93).status, 'differs');
    // A whole-penny deduction has only one right answer
    assert.equal(compareCis({ labour: 1000, ratePct: 20, deduction: 200 }, purchase(1, [{ NetAmount: -199.99, ChargeType: CIS_TYPE }])).status, 'differs');
  });

  it('is missing when KashFlow has no CIS line yet, unless there is nothing to take off', () => {
    assert.equal(compareCis(ours, purchase(1, [labourLine])).status, 'missing');
    assert.equal(compareCis({ deduction: 0 }, purchase(1, [labourLine])).status, 'matches');
  });

  it('is not-synced without the purchase', () => {
    assert.equal(compareCis(ours, null).status, 'not-synced');
  });
});

describe('cisAtSend', () => {
  const lines = [{ description: 'Labour', total: 1234.58, role: 'labour' }, { description: 'Materials', total: 50, role: 'materials' }];
  const doc = { documentType: SI, entry: { invoiceTotal: 1284.58, lines, savedAt: new Date() } };
  const at = new Date('2026-10-30T12:00:00Z');

  it("keeps the supplier's rate on the labour entered", () => {
    assert.deepEqual(cisAtSend(doc, { Code: 'SUB01', WithholdingTaxRate: 20 }, at), {
      supplierCode: 'SUB01', ratePct: 20, labour: 1234.58, deduction: 246.92, payable: 1037.66, at,
    });
  });

  it('is null without a supplier, a rate, or a subcontractor invoice', () => {
    assert.equal(cisAtSend(doc, null, at), null);
    assert.equal(cisAtSend(doc, { Code: 'X', WithholdingTaxRate: null }, at), null);
    assert.equal(cisAtSend({ ...doc, documentType: PI }, { Code: 'X', WithholdingTaxRate: 20 }, at), null);
  });
});

describe('checkSentCis', () => {
  const sent = (paperlessId, purchaseId, extra = {}) => ({
    paperlessId, kashflowPurchaseId: purchaseId, cisAtSend: { deduction: 200 }, deletedInPaperlessAt: null, ...extra,
  });

  it('checks sent invoices not known to match, and keeps the result', async () => {
    const docs = fakeModel([
      sent(1, 11),
      sent(2, 12),
      sent(3, 13),
      sent(4, 14, { cisCheck: { status: 'matches' } }),
      { paperlessId: 5, kashflowPurchaseId: 15, deletedInPaperlessAt: null },
    ]);
    const purchases = fakeModel([
      purchase(11, [{ NetAmount: -200, ChargeType: CIS_TYPE }]),
      purchase(12, [{ NetAmount: -180, ChargeType: CIS_TYPE }]),
      purchase(14, []),
    ]);
    const res = await checkSentCis(docs, purchases, { now: new Date('2026-11-01') });
    assert.deepEqual(res, { checked: 3, matches: 1, differs: 1, missing: 0, 'not-synced': 1 });
    assert.deepEqual(docs.rows.map((d) => d.cisCheck?.status), ['matches', 'differs', 'not-synced', 'matches', undefined]);
    assert.equal(docs.rows[1].cisCheck.difference, -20);
  });

  it('puts missing and differing ones in the CIS to check queue', async () => {
    const docs = fakeModel([sent(1, 11), sent(2, 12), sent(3, 13)]);
    const purchases = fakeModel([purchase(11, [labourLine]), purchase(12, [{ NetAmount: -180, ChargeType: CIS_TYPE }]), purchase(13, [{ NetAmount: -200, ChargeType: CIS_TYPE }])]);
    await checkSentCis(docs, purchases);
    assert.deepEqual(docs.rows.filter(sift(queues.queueFilter('cis-check'))).map((d) => d.paperlessId), [1, 2]);
  });

  it('refreshes one document, and leaves one with nothing kept alone', async () => {
    const docs = fakeModel([sent(1, 11), { paperlessId: 2, kashflowPurchaseId: 12 }]);
    const purchases = fakeModel([purchase(11, [{ NetAmount: -200, ChargeType: CIS_TYPE }])]);
    assert.equal((await refreshCisCheck(docs, purchases, docs.rows[0])).status, 'matches');
    assert.equal(await refreshCisCheck(docs, purchases, docs.rows[1]), null);
  });
});

describe('cisAtSendByPurchaseId', () => {
  it('maps purchase Id to what was kept at send', async () => {
    const docs = fakeModel([
      { paperlessId: 1, kashflowPurchaseId: 11, cisAtSend: { deduction: 200, ratePct: 20 } },
      { paperlessId: 2, kashflowPurchaseId: 12 },
    ]);
    const map = await cisAtSendByPurchaseId(docs, [11, 12, 13]);
    assert.deepEqual([...map.keys()], ['11']);
    assert.equal(map.get('11').paperlessId, 1);
    assert.equal(map.get('11').deduction, 200);
    assert.equal((await cisAtSendByPurchaseId(docs, [])).size, 0);
  });
});

describe('CIS to check queue view', () => {
  const view = path.resolve('mongoose/views/tailwindcss/paperless/queue.ejs');
  const counts = Object.fromEntries(queues.QUEUE_KEYS.map((k) => [k, 0]));

  it('shows ours against KashFlow for each document', async () => {
    const docs = [
      { paperlessId: 1, title: 'a.pdf', added: new Date(), daysWaiting: 1, kashflowPurchaseNumber: 501, cisAtSend: { deduction: 200, ratePct: 20, labour: 1000 }, cisCheck: { status: 'missing' } },
      { paperlessId: 2, title: 'b.pdf', added: new Date(), daysWaiting: 1, cisAtSend: { deduction: 200, ratePct: 20, labour: 1000 }, cisCheck: { status: 'differs', kashflow: 180, difference: -20 } },
    ];
    const html = await ejs.renderFile(view, {
      key: 'cis-check', queue: queues.QUEUES['cis-check'], queues: queues.QUEUES, docs, total: 2, page: 1, pages: 1,
      counts, unclassified: { invoices: 0, statements: 0 }, paperlessUiBase: null,
    });
    assert.match(html, /Not added in KashFlow/);
    assert.match(html, /KashFlow £180\.00 · −£20\.00/);
    assert.match(html, /Purchase 501/);
    assert.match(html, /data-cis-status="differs"/);
  });
});
