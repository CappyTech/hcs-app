import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import fs from 'node:fs';
import path from 'node:path';
import { getPurchaseDraft, sendDraftToKashflow, notDraftableMessage, lineTotalsProblem } from '../mongoose/controllers/paperlessController.js';
import { buildPurchaseDraftFromOcr, buildKashFlowPayloadFromDraft, kashflowQuantityAndRate, kashflowLineTotals } from '../mongoose/services/paperless/purchaseDraftService.js';

// Only purchase and subcontractor invoices become KashFlow purchases. A
// supplier statement is reviewed, never drafted or sent, even by URL.

const query = (doc) => {
  const q = { select: () => q, lean: async () => doc };
  return q;
};
const STATEMENT = { paperlessId: 77, documentType: { id: 13, name: 'Supplier Statement' } };
const INVOICE = { paperlessId: 78, documentType: { id: 1, name: 'Purchase Invoice' } };

function useDoc(doc) {
  const calls = { claims: 0 };
  mdb.PAPERLESS = {
    OcrDocument: {
      findOne: () => query(doc),
      // claimSend would call this: it must not happen for a statement
      findOneAndUpdate: () => { calls.claims += 1; return query(null); },
      updateOne: async () => ({}),
    },
  };
  mdb.REST = {};
  return calls;
}

const fakeRes = () => {
  const res = { statusCode: 200, rendered: null, redirectedTo: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.render = (view, locals) => { res.rendered = { view, locals }; return res; };
  res.redirect = (to) => { res.redirectedTo = to; return res; };
  return res;
};
const fakeReq = (id, body = {}) => {
  const flashes = [];
  return { params: { paperlessId: String(id) }, body, flash: (type, msg) => flashes.push([type, msg]), flashes };
};

describe('KashFlow draft and send are for invoices only', () => {
  const saved = {};
  before(() => {
    saved.connect = mdb.connect;
    saved.PAPERLESS = mdb.PAPERLESS;
    saved.REST = mdb.REST;
    mdb.connect = async () => {};
  });
  after(() => {
    mdb.connect = saved.connect;
    mdb.PAPERLESS = saved.PAPERLESS;
    mdb.REST = saved.REST;
  });

  it('the draft page refuses a supplier statement', async () => {
    useDoc(STATEMENT);
    const res = fakeRes();
    let passedOn = null;
    await getPurchaseDraft(fakeReq(77), res, (err) => { passedOn = err; });
    assert.equal(passedOn, null);
    assert.equal(res.statusCode, 409);
    assert.equal(res.rendered.locals.error.message, 'Supplier statements are reviewed, not sent to KashFlow as a purchase.');
  });

  it('sending a supplier statement is refused before anything is claimed or sent', async () => {
    const calls = useDoc(STATEMENT);
    const req = fakeReq(77);
    const res = fakeRes();
    await sendDraftToKashflow(req, res, () => assert.fail('should not reach the error handler'));
    assert.equal(calls.claims, 0);
    assert.equal(res.redirectedTo, '/paperless/ocr/77/entry');
    assert.deepEqual(req.flashes, [['error', 'Supplier statements are reviewed, not sent to KashFlow as a purchase.']]);
  });

  it('a dry run is refused too', async () => {
    useDoc(STATEMENT);
    const req = fakeReq(77, { dryRun: 'on' });
    const res = fakeRes();
    await sendDraftToKashflow(req, res, () => {});
    assert.equal(res.redirectedTo, '/paperless/ocr/77/entry');
  });

  it('an invoice gets past the check', async () => {
    useDoc(INVOICE);
    const res = fakeRes();
    // Past the guard the real draft builder runs against the stub and may fail;
    // all that matters here is that it wasn't refused as "not an invoice"
    await getPurchaseDraft(fakeReq(78), res, () => {});
    assert.notEqual(res.statusCode, 409);
  });

  it('says what the document is when it is neither', () => {
    assert.equal(notDraftableMessage({ documentType: { name: 'Bank Statement' } }), 'Only purchase and subcontractor invoices are sent to KashFlow as a purchase. This is a Bank Statement.');
    assert.equal(notDraftableMessage({ documentType: { name: 'Receipt' } }), 'Only purchase and subcontractor invoices are sent to KashFlow as a purchase. This is a Receipt.');
    assert.equal(notDraftableMessage({}), 'Only purchase and subcontractor invoices are sent to KashFlow as a purchase. This is a document with no type.');
  });
});

describe('lines that do not add up to the invoice', () => {
  const draft = (lines, net = 71.55, vat = 14.31) => ({ NetAmount: net, VATAmount: vat, GrossAmount: net + vat, LineItems: lines.map(([n, v]) => ({ NetAmount: n, VATAmount: v })) });

  it('are refused, saying what they come to (#1120: bricks entered at the per-thousand price)', () => {
    const msg = lineTotalsProblem(draft([[23.37, 4.67], [794.51, 158.9], [19.3, 3.86], [28.09, 5.62]]));
    assert.equal(msg, "The lines don't add up to the invoice: in KashFlow they would come to net 865.27 (invoice 71.55) and VAT 173.05 (invoice 14.31). Correct the lines in Edit entry, or add the missing ones, before sending.");
  });

  it('pass only when they agree to the penny', () => {
    assert.equal(lineTotalsProblem(draft([[23.37, 4.67], [0.79, 0.16], [19.3, 3.86], [28.09, 5.62]])), null);
    assert.equal(lineTotalsProblem({ NetAmount: 10, LineItems: [] }), null);
    // A penny of VAT out is a purchase a penny out in KashFlow
    assert.match(lineTotalsProblem(draft([[38.18, 7.63]], 38.18, 7.64)), /VAT 7\.63 \(invoice 7\.64\)/);
  });

  it('are checked as KashFlow will total them, Quantity × Rate, not by the line total it ignores', () => {
    // Line total 18.00 but 2 × 10.00 sent would make 20.00 in KashFlow
    const d = { InvoiceTotals: { NetAmount: 18, VATAmount: 3.6, GrossAmount: 21.6 }, LineItems: [{ Quantity: 2, UnitPrice: 10, NetAmount: 18, VATAmount: 3.6 }] };
    assert.equal(lineTotalsProblem(d), null, 'sent as 1 × 18.00, so KashFlow makes 18.00');
    assert.deepEqual(kashflowLineTotals(buildKashFlowPayloadFromDraft(d)), { net: 18, vat: 3.6, gross: 21.6 });
  });

  it('are checked against the totals typed from the invoice, not totals taken from the lines', () => {
    // The draft's header was aligned to the lines; the invoice said 100.00 + 20.00
    const d = { NetAmount: 90, VATAmount: 18, GrossAmount: 108, InvoiceTotals: { NetAmount: 100, VATAmount: 20, GrossAmount: 120 }, LineItems: [{ NetAmount: 90, VATAmount: 18 }] };
    assert.match(lineTotalsProblem(d), /net 90\.00 \(invoice 100\.00\) and VAT 18\.00 \(invoice 20\.00\)/);
  });

  it('check the invoice total when it is the only total typed', () => {
    const d = { InvoiceTotals: { NetAmount: null, VATAmount: null, GrossAmount: 120 }, LineItems: [{ NetAmount: 90, VATAmount: 18 }] };
    assert.match(lineTotalsProblem(d), /a total of 108\.00 \(invoice 120\.00\)/);
  });

  it('are refused when no invoice totals were entered to check them against', () => {
    const d = { InvoiceTotals: { NetAmount: null, VATAmount: null, GrossAmount: null }, LineItems: [{ NetAmount: 90, VATAmount: 18 }] };
    assert.match(lineTotalsProblem(d), /totals haven't been entered/);
  });
});

describe('lines sent to KashFlow match the invoice line totals', () => {
  it('keep quantity and price when they make the line total', () => {
    assert.deepEqual(kashflowQuantityAndRate({ Description: 'Sand', Quantity: 3, UnitPrice: 12.5, NetAmount: 37.5 }), { Quantity: 3, Rate: 12.5, Description: 'Sand' });
  });

  it('go as 1 × the printed total when quantity × price does not (a discount)', () => {
    assert.deepEqual(kashflowQuantityAndRate({ Description: 'Timber', Quantity: 2, UnitPrice: 10, NetAmount: 18 }), { Quantity: 1, Rate: 18, Description: 'Timber (2 × 10)' });
  });

  it('go as 1 × the printed total when a 4-place price would be pence out on a large quantity', () => {
    // 5000 × 0.7945 = 3972.50, the invoice says 3972.55
    assert.deepEqual(kashflowQuantityAndRate({ Description: 'Bricks', Quantity: 5000, UnitPrice: 0.7945, NetAmount: 3972.55 }), { Quantity: 1, Rate: 3972.55, Description: 'Bricks (5000 × 0.7945)' });
  });

  it('go as 1 × the total when there is a quantity but no price, not quantity × total', () => {
    assert.deepEqual(kashflowQuantityAndRate({ Description: 'Hire', Quantity: 5, NetAmount: 50 }), { Quantity: 1, Rate: 50, Description: 'Hire (qty 5)' });
  });

  it('keep the printed line total from the entry screen instead of correcting it to quantity × price', () => {
    const ocr = {
      paperlessId: 1,
      customFields: [],
      entry: {
        savedAt: new Date(), invoiceNumber: 'T-1', totalGoods: 18, totalVat: 3.6, invoiceTotal: 21.6,
        lines: [{ description: 'Timber', quantity: 2, price: 10, total: 18, vatRate: 20 }],
      },
    };
    const d = buildPurchaseDraftFromOcr(ocr);
    assert.equal(d.LineItems[0].NetAmount, 18);
    assert.deepEqual(d.InvoiceTotals, { NetAmount: 18, VATAmount: 3.6, GrossAmount: 21.6 });
    assert.equal(lineTotalsProblem(d), null);
    const p = buildKashFlowPayloadFromDraft(d);
    assert.deepEqual([p.LineItems[0].Quantity, p.LineItems[0].Rate], [1, 18]);
  });

  it('refuse a draft whose lines were short of the typed totals, even though its header was aligned to them', () => {
    const ocr = {
      paperlessId: 2,
      customFields: [],
      // Goods + VAT isn't the invoice total, so the draft header is taken from the lines
      entry: { savedAt: new Date(), invoiceNumber: 'T-2', totalGoods: 100, totalVat: 20, invoiceTotal: 130, lines: [{ description: 'A', quantity: 1, price: 100, total: 100, vatRate: 20 }] },
    };
    const d = buildPurchaseDraftFromOcr(ocr);
    assert.match(lineTotalsProblem(d), /a total of 120\.00 \(invoice 130\.00\)/);
  });

  it('are checked on send after lines added on the draft page, before anything goes to KashFlow', () => {
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    const send = ctrl.slice(ctrl.indexOf('export const sendDraftToKashflow'));
    const added = send.indexOf('draft.LineItems.push(...parsedExtras.lines)');
    const guard = send.indexOf('lineTotalsProblem(draft)');
    const dry = send.indexOf('if (dryRun)');
    assert.ok(added > 0 && guard > added && guard < dry, 'guard sits after extra lines and before the send');
  });

  it('can be sent anyway when the sender confirms the invoice itself does not add up, and that is noted on the document', () => {
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    const send = ctrl.slice(ctrl.indexOf('export const sendDraftToKashflow'));
    // The override is read from the form, the refusal only applies without it
    assert.match(send, /acceptLineMismatch = \["true", "on", "1", "yes"\]\.includes\(\s*String\(req\.body\?\.acceptLineMismatch/);
    assert.match(send, /if \(linesProblem && !acceptLineMismatch\) \{[\s\S]*?send refused/);
    // An accepted mismatch is written to the document's history on both send paths
    assert.match(send, /if \(linesProblem && acceptLineMismatch\) \{\s*sentNote = /);
    assert.equal((send.match(/recordSentToKashflow\([^\n]*\{ note: sentNote \}\)/g) || []).length, 2, 'direct and webhook paths');
    // The draft page only offers the override when the lines don't add up
    const view = fs.readFileSync(path.resolve('mongoose/views/tailwindcss/paperless/draft.ejs'), 'utf8');
    assert.match(view, /<% if \(locals\.linesProblem\) \{ %>\s*<label[^]*?name="acceptLineMismatch"/);
  });
});
