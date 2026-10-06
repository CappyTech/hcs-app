import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makePdf } from './helpers/makePdf.js';
import { memoryModel } from './helpers/memoryModel.js';
import svc from '../mongoose/services/paperless/documentReadingService.js';

const ejs = createRequire(import.meta.url)('ejs');
const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

// Electricfix/Screwfix: the total is "Charged to Account: £45.42" and the
// invoice number sits beside "Our Reference", neither a label the reader knows
const ELECTRICFIX = [
  ['Electricfix', 36, 800], ['Our Reference:', 394, 689], ['0726A26825510698', 460, 689],
  ['Total', 300, 300], ['120.00', 450, 300],
  ['Charged to Account: £45.42', 32, 84],
];
const models = (seed = {}) => ({
  OcrDocument: memoryModel(seed.docs || [
    { paperlessId: 1005, title: 'Invoice 1005', correspondent: { id: 9, name: 'Electricfix' }, processingState: 'entered', deletedInPaperlessAt: null, added: new Date('2026-09-01') },
    { paperlessId: 1006, title: 'Invoice 1006', correspondent: { id: 9, name: 'Electricfix' }, processingState: 'awaiting_entry', deletedInPaperlessAt: null, added: new Date('2026-09-20') },
  ]),
  DocumentText: memoryModel(seed.text || []),
  SupplierLayout: memoryModel(seed.layouts || []),
  Supplier: memoryModel([]),
  Purchase: memoryModel([]),
});
const depsFor = (m) => ({ connect: null, models: () => m, fetchPdf: async () => makePdf([ELECTRICFIX]), now: () => new Date('2026-10-06T12:00:00Z') });

describe('teaching the reader about a supplier', () => {
  it('label words are cleaned: split on lines or commas, trimmed, de-duplicated, capped', () => {
    assert.deepEqual(svc.cleanLabels('Charged to Account,  charged  to account\nOur   Ref, x,'), ['Charged to Account', 'Our Ref']);
    assert.equal(svc.cleanLabels(Array.from({ length: 20 }, (_, i) => `Label ${i}`)).length, 10);
  });

  it('label words change what the reader finds for that supplier', async () => {
    const m = models();
    const before = await svc.readDocument(1006, depsFor(m));
    assert.equal(before.fields.invoiceTotal.value, '120.00');
    assert.equal(before.fields.invoiceNumber, null);
    await svc.setLabels(9, 'invoiceTotal', 'Charged to Account', { name: 'Electricfix' }, depsFor(m));
    await svc.setLabels(9, 'invoiceNumber', ['Our Reference'], {}, depsFor(m));
    const after = await svc.readDocument(1006, depsFor(m));
    assert.equal(after.fields.invoiceTotal.value, '45.42');
    assert.equal(after.fields.invoiceNumber.value, '0726A26825510698');
    assert.equal(after.usedLabels, true);
    assert.deepEqual((await svc.hintsFor({ correspondent: { id: 9 } }, depsFor(m))).labels, { invoiceTotal: ['Charged to Account'], invoiceNumber: ['Our Reference'] });
    // Empty clears them
    await svc.setLabels(9, 'invoiceTotal', '', {}, depsFor(m));
    assert.deepEqual(m.SupplierLayout.docs[0].labels, { invoiceNumber: ['Our Reference'] });
  });

  it('a spot pointed out by hand goes first, ahead of learned ones, and is used next read', async () => {
    const m = models({ layouts: [{ correspondentId: 9, correspondentName: 'Electricfix', spots: { invoiceTotal: [{ page: 1, x: 450, y: 297.5, w: 30, h: 12.5, seen: 4 }] }, labels: {} }] });
    const r = await svc.teach(9, 'invoiceTotal', { page: 1, x: 140, y: 81.5, w: 30, h: 12.5 }, {}, depsFor(m));
    assert.equal(r.ok, true);
    assert.equal(r.spots[0].taught, true);
    assert.equal(r.spots[0].seen, 9);
    assert.equal(r.spots[1].seen, 4);
    const reading = await svc.readDocument(1006, depsFor(m));
    assert.equal(reading.fields.invoiceTotal.value, '45.42');
  });

  it('refuses an unknown field or a box that is not on a page', async () => {
    const m = models();
    assert.equal((await svc.teach(9, 'supplierName', { page: 1, x: 1, y: 1, w: 1, h: 1 }, {}, depsFor(m))).ok, false);
    assert.equal((await svc.teach(9, 'invoiceTotal', { page: 0, x: 1, y: 1, w: 1, h: 1 }, {}, depsFor(m))).ok, false);
    assert.equal((await svc.teach(9, 'invoiceTotal', { page: 1, x: 'a', y: 1, w: 1, h: 1 }, {}, depsFor(m))).ok, false);
    assert.equal((await svc.setLabels(9, 'nope', 'x y', {}, depsFor(m))).ok, false);
  });

  it('forgets one field, or everything', async () => {
    const m = models({ layouts: [{ correspondentId: 9, spots: { invoiceTotal: [{ page: 1, x: 1, y: 1, w: 1, h: 1, seen: 1 }], invoiceNumber: [{ page: 1, x: 2, y: 2, w: 1, h: 1, seen: 1 }] }, labels: { invoiceTotal: ['Charged'] }, invoicesLearned: 3 }] });
    await svc.forget(9, 'invoiceTotal', depsFor(m));
    assert.deepEqual(Object.keys(m.SupplierLayout.docs[0].spots), ['invoiceNumber']);
    assert.deepEqual(m.SupplierLayout.docs[0].labels, { invoiceTotal: ['Charged'] }, 'forgetting a place keeps the label words');
    await svc.forget(9, null, depsFor(m));
    assert.deepEqual(m.SupplierLayout.docs[0].spots, {});
    assert.deepEqual(m.SupplierLayout.docs[0].labels, {});
    assert.equal(m.SupplierLayout.docs[0].invoicesLearned, 0);
  });

  it('the supplier page has the latest invoices and which of them have been read', async () => {
    const m = models();
    await svc.readDocument(1005, depsFor(m));
    const d = await svc.supplierDetail(9, depsFor(m));
    assert.equal(d.name, 'Electricfix');
    assert.deepEqual(d.documents.map((x) => [x.paperlessId, x.hasText]), [[1006, false], [1005, true]]);
    assert.equal(await svc.supplierDetail(12345, depsFor(m)), null);
  });
});

describe('supplier reading page: routes and view', () => {
  it('every route is behind the Paperless guard and admin-only', () => {
    const routes = read('mongoose/routes/paperlessRoutes.js');
    const perms = read('mongoose/config/rolePermissionsConfig.js');
    for (const [method, p, fn] of [
      ['get', '/paperless/reading/supplier/:correspondentId', 'getSupplier'],
      ['post', '/paperless/reading/supplier/:correspondentId/teach', 'postTeach'],
      ['post', '/paperless/reading/supplier/:correspondentId/forget', 'postForget'],
      ['post', '/paperless/reading/supplier/:correspondentId/labels', 'postLabels'],
    ]) {
      assert.ok(routes.includes(`router.${method}("${p}", ...paperlessGuard, readingCtrl.${fn})`), `${method} ${p}`);
      const line = perms.split('\n').find((l) => l.includes(`'${p}':`));
      assert.ok(line && line.includes("['admin']"), p);
    }
  });

  it('renders what is learned, the teach buttons and the label word forms', async () => {
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/supplierReading.ejs'), {
      detail: {
        correspondentId: 9, name: 'Electricfix', invoicesLearned: 2,
        spots: { invoiceTotal: [{ page: 1, x: 1, y: 1, w: 1, h: 1, seen: 9, taught: true, lastAt: new Date('2026-10-06') }], invoiceNumber: [{ page: 1, x: 1, y: 1, w: 1, h: 1, seen: 2, lastAt: new Date('2026-10-05') }] },
        labels: { invoiceTotal: ['Charged to Account'] },
        documents: [{ paperlessId: 1005, title: 'Invoice 1005', hasText: true, added: new Date(), readingOutcome: { fields: { invoiceTotal: 'corrected' } } }, { paperlessId: 1006, title: 'Invoice 1006', hasText: false }],
      },
      shown: { paperlessId: 1005, title: 'Invoice 1005' },
      fields: svc.HEADER_FIELDS,
      fieldLabels: { invoiceNumber: 'Invoice number', invoiceDate: 'Invoice date', dueDate: 'Due date', totalGoods: 'Total goods', totalVat: 'Total VAT', invoiceTotal: 'Invoice total' },
      csrfToken: 't',
    }, { views: [path.resolve('mongoose/views')] });
    assert.match(html, /Pointed out by hand/);
    assert.match(html, /Seen in this place on 2 saved invoices/);
    assert.match(html, /data-teach-field="invoiceTotal"/);
    assert.match(html, />Charged to Account<\/textarea>/);
    assert.match(html, /action="\/paperless\/reading\/supplier\/9\/forget"/);
    assert.match(html, /data-src="\/paperless\/ocr\/1005\/file"/);
    assert.match(html, /1 field corrected when saved/);
    assert.match(html, /<script type="module" src="\/resources\/js\/supplier-teach\.js"><\/script>/);
    assert.ok(!/<script[^>]*>[^<]/.test(html), 'no inline script');
  });

  it('the entry screen links to it and hands the label words to the reader', () => {
    const entry = read('mongoose/views/tailwindcss/paperless/entry.ejs');
    assert.match(entry, /href="\/paperless\/reading\/supplier\/<%= doc\.correspondent\.id %>"/);
    assert.match(entry, /data-labels="<%= JSON\.stringify\(locals\.labels \|\| \{\}\) %>"/);
    const sugg = read('public/js/document-suggestions.js');
    assert.match(sugg, /findFields\(items, \{ pageWidth: width, layout, labels \}\)/);
    assert.match(sugg, /from '\/resources\/js\/pdf-marks\.js'/);
    assert.match(read('public/js/supplier-teach.js'), /from '\/resources\/js\/pdf-marks\.js'/);
  });
});
