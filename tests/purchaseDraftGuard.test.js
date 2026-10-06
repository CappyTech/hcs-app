import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import fs from 'node:fs';
import path from 'node:path';
import { getPurchaseDraft, sendDraftToKashflow, notDraftableMessage, lineTotalsProblem } from '../mongoose/controllers/paperlessController.js';

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
    assert.equal(msg, "The lines don't add up to the invoice: they come to net 865.27 (invoice 71.55) and VAT 173.05 (invoice 14.31). Correct the lines in Edit entry, or add the missing ones, before sending.");
  });

  it('pass when they agree, allowing a penny of VAT rounding a line', () => {
    assert.equal(lineTotalsProblem(draft([[23.37, 4.67], [0.79, 0.16], [19.3, 3.86], [28.09, 5.62]])), null);
    assert.equal(lineTotalsProblem(draft([[38.18, 7.63]], 38.18, 7.64)), null);
    assert.equal(lineTotalsProblem({ NetAmount: 10, LineItems: [] }), null);
  });

  it('are checked on send after lines added on the draft page, before anything goes to KashFlow', () => {
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    const send = ctrl.slice(ctrl.indexOf('export const sendDraftToKashflow'));
    const added = send.indexOf('draft.LineItems.push(...parsedExtras.lines)');
    const guard = send.indexOf('lineTotalsProblem(draft)');
    const dry = send.indexOf('if (dryRun)');
    assert.ok(added > 0 && guard > added && guard < dry, 'guard sits after extra lines and before the send');
  });
});
