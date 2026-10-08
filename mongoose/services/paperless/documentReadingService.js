/**
 * documentReadingService.js — the invoice reader, run on the server.
 *
 * The entry screen already reads each PDF in the browser. Doing it once here
 * as well means:
 *   - the queue can show what was read (number, total) before anyone opens a
 *     document, and put the best-read ones first;
 *   - a supplier's layout can be learned from what people save, and handed
 *     back to the reader for that supplier's next invoice;
 *   - each save can be scored against what was read, for an accuracy report
 *     and for test fixtures built from real corrections;
 *   - documents with no text layer can be spotted and sent back to Paperless
 *     for OCR.
 *
 * The reader itself is the same code the browser runs
 * (public/js/invoice-field-finder.js, invoice-line-finder.js). Nothing here
 * writes to an entry: reading only ever suggests.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import mdb from '../mongooseDatabaseService.js';
import __paperlessClient from './paperlessClient.js';
import configService from '../../../services/configService.js';
import logger from '../../../services/loggerService.js';
import { refreshTypeCheck } from './documentTypeCheck.js';
import {
  findFields, locateValue, normalise, toItems, FIELDS,
} from '../../../public/js/invoice-field-finder.js';
import {
  findLines, fillMissingRates, findPaymentTerms, findVatNumbers, normaliseVatNumber,
} from '../../../public/js/invoice-line-finder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump when the reader changes enough that stored readings should be redone
export const READER_VERSION = 3; // 2: per-hundred and per-thousand prices; 3: bare "VAT" label past the rate (Beers)
export const MAX_PAGES = 5;
export const HEADER_FIELDS = FIELDS.map((f) => f.field);
const TYPE = Object.fromEntries(FIELDS.map((f) => [f.field, f.type]));
// Places kept per field in a supplier layout, and how close counts as the same place
const SPOTS_KEPT = 3;
const SAME_SPOT = 12;

// ── Reading a PDF ────────────────────────────────────────────────────

let pdfjsPromise = null;
function loadPdfjs() {
  // The Node build of the PDF.js the browser uses; loaded on first use only
  pdfjsPromise ||= import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href);
  return pdfjsPromise;
}

/** Items as stored: [text, x, y, width, height, page], rounded to 0.1 pt. */
const r1 = (n) => Math.round(n * 10) / 10;
export const packItem = (it) => [it.str, r1(it.x), r1(it.y), r1(it.w), r1(it.h), it.page];
export const unpackItem = ([str, x, y, w, h, page]) => ({ str, x, y, w, h, page });

/**
 * The positioned text of a PDF, in the shape the reader takes.
 * @param {Uint8Array|Buffer} data
 * @returns {Promise<{items: Array, pages: number, pageWidth: number}>}
 */
export async function extractItems(data, { maxPages = MAX_PAGES } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const items = [];
    let pageWidth = 595;
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      if (i === 1) pageWidth = page.getViewport({ scale: 1 }).width;
      const tc = await page.getTextContent();
      items.push(...toItems(tc.items, i));
    }
    return { items, pages: doc.numPages, pageWidth };
  } finally {
    // PDF.js 6 frees a document through its loading task
    await task.destroy();
  }
}

const slim = (g) => (g ? { value: g.value, page: g.page, box: roundBox(g.box), ...(g.learned ? { learned: true } : {}) } : null);
const roundBox = (b) => (b ? { page: b.page, x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) } : null);

/**
 * What the reader makes of a document's items: the stored `reading`.
 * @param {Array} items
 * @param {object} [opts] { pageWidth, pages, layout }
 */
export function summarise(items, { pageWidth = 595, pages = null, layout = null, labels = null, now = new Date() } = {}) {
  const found = findFields(items, { pageWidth, layout: layout || undefined, labels: labels || undefined });
  const fields = Object.fromEntries(HEADER_FIELDS.map((f) => [f, slim(found[f])]));
  const terms = findPaymentTerms(items, fields.invoiceDate?.value);
  if (!fields.dueDate && terms?.dueDate) {
    fields.dueDate = { value: terms.dueDate, page: terms.page, box: roundBox(terms.box), fromTerms: terms.text };
  }
  const lines = fillMissingRates(findLines(items), fields.totalGoods?.value, fields.totalVat?.value)
    .map((l) => ({
      description: l.description, quantity: l.quantity, price: l.price, total: l.total, vatRate: l.vatRate,
      page: l.page, box: roundBox(l.box),
    }));
  const score = ['invoiceNumber', 'invoiceDate', 'invoiceTotal'].filter((f) => fields[f]).length;
  return {
    version: READER_VERSION,
    at: now,
    hasText: items.length > 0,
    pages,
    score,
    fields,
    lines,
    lineCount: lines.length,
    linesAddUp: !!(lines.length && fields.totalGoods
      && Math.abs(lines.reduce((s, l) => s + l.total, 0) - Number(fields.totalGoods.value)) < 0.011),
    vatNumbers: findVatNumbers(items).map((v) => ({ number: v.number, page: v.page, box: roundBox(v.box) })),
    terms: terms ? { text: terms.text, days: terms.days, eom: terms.eom, eomFollowing: terms.eomFollowing } : null,
    usedLayout: !!(layout && Object.keys(layout).length),
    usedLabels: !!(labels && Object.values(labels).some((l) => l?.length)),
  };
}

// ── Supplier layouts ─────────────────────────────────────────────────

/** The best-seen spot per field, as the reader takes it. */
export function layoutFromSpots(spots = {}) {
  const out = {};
  for (const [field, list] of Object.entries(spots || {})) {
    const best = [...(list || [])].sort((a, b) => b.seen - a.seen)[0];
    if (best) out[field] = { page: best.page, x: best.x, y: best.y, w: best.w, h: best.h };
  }
  return out;
}

/**
 * Fold where this invoice had each saved value into a supplier's spots.
 * Pure: returns the new spots.
 */
export function mergeSpots(spots = {}, found = {}, now = new Date()) {
  const out = { ...spots };
  for (const [field, box] of Object.entries(found)) {
    if (!box) continue;
    const list = [...(out[field] || [])];
    const same = list.find((s) => s.page === box.page && Math.hypot(s.x + s.w - (box.x + box.w), s.y - box.y) <= SAME_SPOT);
    if (same) {
      Object.assign(same, { x: r1(box.x), y: r1(box.y), w: r1(box.w), h: r1(box.h), lastAt: now });
      same.seen += 1;
    } else {
      list.push({ page: box.page, x: r1(box.x), y: r1(box.y), w: r1(box.w), h: r1(box.h), seen: 1, lastAt: now });
    }
    out[field] = list.sort((a, b) => b.seen - a.seen || new Date(b.lastAt) - new Date(a.lastAt)).slice(0, SPOTS_KEPT);
  }
  return out;
}

/** Saved header values as the reader would write them, for comparing. */
export function savedValues(entry) {
  if (!entry) return {};
  const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const m = (n) => (n == null ? null : Number(n).toFixed(2));
  return {
    invoiceNumber: entry.invoiceNumber || null,
    invoiceDate: iso(entry.invoiceDate),
    dueDate: iso(entry.dueDate),
    totalGoods: m(entry.totalGoods),
    totalVat: m(entry.totalVat),
    invoiceTotal: m(entry.invoiceTotal),
  };
}

/**
 * Per field: matched (read = saved), corrected (read ≠ saved), filled (nothing
 * read, typed by hand), missed (read, saved blank), none (neither).
 */
export function compareReading(reading, entry) {
  const saved = savedValues(entry);
  const out = {};
  for (const f of HEADER_FIELDS) {
    const got = reading?.fields?.[f]?.value ?? null;
    const want = saved[f];
    if (got == null && want == null) out[f] = 'none';
    else if (got == null) out[f] = 'filled';
    else if (want == null) out[f] = 'missed';
    else out[f] = normalise(TYPE[f], got) === normalise(TYPE[f], want) ? 'matched' : 'corrected';
  }
  return out;
}

// ── Checks against KashFlow data ─────────────────────────────────────

const normRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The KashFlow supplier a correspondent stands for: exact name or code, any case. */
export async function supplierFor(Supplier, correspondentName) {
  const name = String(correspondentName || '').trim();
  if (!Supplier || !name) return null;
  const re = new RegExp(`^${escapeRe(name)}$`, 'i');
  return Supplier.findOne({ $or: [{ Name: re }, { Code: re }] })
    .select('Id Code Name VatNumber IsArchived')
    .lean();
}

/**
 * Does the VAT number on the document belong to the supplier filed against it?
 * @returns {{status: 'match'|'mismatch'|'none_found'|'supplier_has_none'|'no_supplier', found: string[], supplierVat: string|null, belongsTo: Array<{name, code}>}}
 */
export async function vatCheck(Supplier, supplier, numbers, { ownVat = configService.get('COMPANY_VAT_NUMBER', '') } = {}) {
  const own = normaliseVatNumber(ownVat);
  const found = [...new Set((numbers || []).map(normaliseVatNumber).filter(Boolean))].filter((n) => n !== own);
  const supplierVat = normaliseVatNumber(supplier?.VatNumber);
  let status;
  if (!supplier) status = 'no_supplier';
  else if (!found.length) status = 'none_found';
  else if (!supplierVat) status = 'supplier_has_none';
  else status = found.includes(supplierVat) ? 'match' : 'mismatch';
  let belongsTo = [];
  if (Supplier && found.length && status !== 'match') {
    // Who the number on the document does belong to
    const all = await Supplier.find({ VatNumber: { $exists: true, $nin: [null, ''] } }).select('Name Code VatNumber').lean();
    belongsTo = all.filter((s) => found.includes(normaliseVatNumber(s.VatNumber)) && s.Code !== supplier?.Code)
      .map((s) => ({ name: s.Name, code: s.Code }));
  }
  return { status, found, supplierVat, belongsTo };
}

/**
 * The same invoice number already in KashFlow for this supplier, or on
 * another Paperless document filed against the same correspondent.
 */
export async function duplicatesOf({ Purchase, OcrDocument }, doc, invoiceNumber, supplier) {
  const want = normRef(invoiceNumber);
  if (!want) return { kashflow: [], documents: [] };
  // Purchases store the supplier's invoice number in SupplierReference; match
  // loosely in Mongo, then exactly once normalised ("INV-0042" = "inv 0042")
  const loose = new RegExp(want.split('').map(escapeRe).join('[^A-Za-z0-9]*'), 'i');
  const who = supplier
    ? { $or: [{ SupplierId: supplier.Id }, { SupplierCode: supplier.Code }, { SupplierName: supplier.Name }] }
    : {};
  const [purchases, docs] = await Promise.all([
    Purchase
      ? Purchase.find({ SupplierReference: loose, ...who }).select('Number SupplierReference SupplierName IssuedDate GrossAmount').limit(5).lean()
      : [],
    OcrDocument
      ? OcrDocument.find({
        paperlessId: { $ne: doc.paperlessId },
        deletedInPaperlessAt: null,
        ...(doc.correspondent?.id != null ? { 'correspondent.id': doc.correspondent.id } : {}),
        $or: [{ 'entry.invoiceNumber': loose }, { 'reading.fields.invoiceNumber.value': loose }],
      }).select('paperlessId title processingState entry.invoiceNumber reading.fields.invoiceNumber.value').limit(5).lean()
      : [],
  ]);
  return {
    kashflow: purchases.filter((p) => normRef(p.SupplierReference) === want).map((p) => ({
      number: p.Number, reference: p.SupplierReference, supplier: p.SupplierName,
      date: p.IssuedDate || null, gross: p.GrossAmount ?? null,
    })),
    documents: docs.filter((d) => normRef(d.entry?.invoiceNumber) === want || normRef(d.reading?.fields?.invoiceNumber?.value) === want)
      .map((d) => ({ paperlessId: d.paperlessId, title: d.title || null, state: d.processingState || null })),
  };
}

// ── Running it ───────────────────────────────────────────────────────

const defaultDeps = () => ({
  connect: () => mdb.connect(),
  models: () => ({
    OcrDocument: mdb.PAPERLESS?.OcrDocument,
    DocumentText: mdb.PAPERLESS?.DocumentText,
    SupplierLayout: mdb.PAPERLESS?.SupplierLayout,
    Supplier: mdb.REST?.supplier,
    Purchase: mdb.REST?.purchase,
  }),
  fetchPdf: async (paperlessId) => {
    const file = await __paperlessClient.makeClient().getDocumentFile(paperlessId);
    const chunks = [];
    for await (const c of file.stream) chunks.push(c);
    return Buffer.concat(chunks);
  },
  extract: extractItems,
  now: () => new Date(),
});
const withDeps = (deps) => {
  const d = { ...defaultDeps(), ...deps };
  return { ...d, m: { ...defaultDeps().models(), ...(deps.models ? deps.models() : {}) } };
};

// What a supplier's layout gives the reader: learned spots and label words
async function hintsForDoc(SupplierLayout, doc) {
  if (!SupplierLayout || doc?.correspondent?.id == null) return { layout: null, labels: null };
  const l = await SupplierLayout.findOne({ correspondentId: doc.correspondent.id }).lean();
  return { layout: l ? layoutFromSpots(l.spots) : null, labels: l?.labels || null };
}
async function layoutForDoc(SupplierLayout, doc) {
  return (await hintsForDoc(SupplierLayout, doc)).layout;
}

/** The learned layout and label words for a document's supplier, for the entry screen's reader. */
export async function hintsFor(doc, deps = {}) {
  const d = withDeps(deps);
  return hintsForDoc(d.m.SupplierLayout, doc);
}
export async function layoutFor(doc, deps = {}) {
  return (await hintsFor(doc, deps)).layout;
}

/**
 * Read one document: fetch the PDF (or reuse stored text), run the reader with
 * the supplier's learned layout, store text and reading.
 * @returns {Promise<object|null>} the reading
 */
export async function readDocument(paperlessId, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, DocumentText, SupplierLayout } = d.m;
  const doc = await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent').lean();
  if (!doc) return null;
  const now = d.now();
  let reading;
  try {
    let stored = deps.refetch ? null : await DocumentText?.findOne({ paperlessId }).lean();
    if (!stored) {
      const { items, pages, pageWidth } = await d.extract(await d.fetchPdf(paperlessId));
      stored = { paperlessId, items: items.map(packItem), pages, pageWidth };
      await DocumentText?.updateOne(
        { paperlessId },
        { $set: { ...stored, readAt: now, readerVersion: READER_VERSION } },
        { upsert: true },
      );
    }
    const items = stored.items.map(unpackItem);
    const { layout, labels } = await hintsForDoc(SupplierLayout, doc);
    reading = summarise(items, { pageWidth: stored.pageWidth, pages: stored.pages, layout, labels, now });
  } catch (err) {
    logger.warn(`[documentReading] ${paperlessId}: ${err.message}`);
    reading = { version: READER_VERSION, at: now, error: err.message, score: -1 };
  }
  await OcrDocument.updateOne({ paperlessId }, { $set: { reading } });
  await refreshTypeCheck(OcrDocument, paperlessId).catch(() => {});
  return reading;
}

// One at a time in the background, each document once
const queued = new Set();
let draining = null;
export function readSoon(paperlessId, deps = {}) {
  queued.add(Number(paperlessId));
  draining ||= (async () => {
    try {
      while (queued.size) {
        const [next] = queued;
        queued.delete(next);
        try { await readDocument(next, deps); } catch (err) { logger.warn(`[documentReading] ${next}: ${err.message}`); }
      }
    } finally {
      draining = null;
    }
  })();
  return draining;
}

/** Invoices still to be entered that have no reading, or an old one. For the scheduled job. */
export async function readMissing({ limit = 20 } = {}, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument } = d.m;
  const docs = await OcrDocument.find({
    processingState: { $in: ['awaiting_entry', 'entered'] },
    excludedReason: null,
    deletedInPaperlessAt: null,
    $or: [{ reading: { $exists: false } }, { 'reading.version': { $lt: READER_VERSION } }],
  }).select('paperlessId').sort({ added: -1 }).limit(limit).lean();
  let read = 0;
  for (const { paperlessId } of docs) {
    await readDocument(paperlessId, deps);
    read += 1;
  }
  return { read };
}

/**
 * After a save: learn where this supplier puts each field, and score the
 * reading against what was saved. Never throws; runs after the response.
 */
export async function learnFromSave(paperlessId, deps = {}) {
  try {
    const d = withDeps(deps);
    if (d.connect) await d.connect();
    const { OcrDocument, DocumentText, SupplierLayout } = d.m;
    const doc = await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent entry reading').lean();
    if (!doc?.entry) return null;
    if (!doc.reading || doc.reading.error) await readDocument(paperlessId, deps);
    const fresh = doc.reading && !doc.reading.error ? doc : await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent entry reading').lean();
    const now = d.now();
    const outcome = { at: now, version: READER_VERSION, fields: compareReading(fresh.reading, fresh.entry) };
    await OcrDocument.updateOne({ paperlessId }, { $set: { readingOutcome: outcome } });

    const text = await DocumentText?.findOne({ paperlessId }).lean();
    if (!text?.items?.length || !SupplierLayout || fresh.correspondent?.id == null) return outcome;
    const items = text.items.map(unpackItem);
    const saved = savedValues(fresh.entry);
    const found = {};
    for (const f of HEADER_FIELDS) {
      const at = saved[f] ? locateValue(items, f, saved[f]) : null;
      if (at) found[f] = at.box;
    }
    if (!Object.keys(found).length) return outcome;
    const existing = await SupplierLayout.findOne({ correspondentId: fresh.correspondent.id }).lean();
    await SupplierLayout.updateOne(
      { correspondentId: fresh.correspondent.id },
      {
        $set: { correspondentName: fresh.correspondent.name || null, spots: mergeSpots(existing?.spots, found, now) },
        $inc: { invoicesLearned: 1 },
      },
      { upsert: true },
    );
    return outcome;
  } catch (err) {
    logger.warn(`[documentReading] learn ${paperlessId}: ${err.message}`);
    return null;
  }
}

/**
 * What the entry screen asks for: the matched supplier, whether the document's
 * VAT number is theirs, duplicates of the invoice number, and the learned layout.
 */
export async function insights(paperlessId, { invoiceNumber = null, vatNumbers = null } = {}, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, SupplierLayout, Supplier, Purchase } = d.m;
  const doc = await OcrDocument.findOne({ paperlessId })
    .select('paperlessId correspondent reading entry.invoiceNumber').lean();
  if (!doc) return null;
  const supplier = await supplierFor(Supplier, doc.correspondent?.name);
  const numbers = vatNumbers?.length ? vatNumbers : (doc.reading?.vatNumbers || []).map((v) => v.number);
  const number = invoiceNumber ?? doc.entry?.invoiceNumber ?? doc.reading?.fields?.invoiceNumber?.value ?? null;
  const [vat, duplicates, layout] = await Promise.all([
    vatCheck(Supplier, supplier, numbers, deps.ownVat != null ? { ownVat: deps.ownVat } : undefined),
    duplicatesOf({ Purchase, OcrDocument }, doc, number, supplier),
    layoutForDoc(SupplierLayout, doc),
  ]);
  return {
    supplier: supplier ? { name: supplier.Name, code: supplier.Code, vatNumber: normaliseVatNumber(supplier.VatNumber) } : null,
    vat,
    invoiceNumber: number,
    duplicates,
    layout,
    reading: doc.reading ? { hasText: doc.reading.hasText, error: doc.reading.error || null, at: doc.reading.at } : null,
  };
}

/**
 * How well the reader does: per supplier and field, how often what it read
 * was saved unchanged. Built from every saved document's readingOutcome.
 */
export async function accuracyReport(deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument } = d.m;
  const docs = await OcrDocument.find({ readingOutcome: { $exists: true } })
    .select('paperlessId title correspondent readingOutcome reading.hasText').lean();
  const blank = () => Object.fromEntries(HEADER_FIELDS.map((f) => [f, { matched: 0, corrected: 0, filled: 0, missed: 0, none: 0 }]));
  const overall = blank();
  const bySupplier = new Map();
  const corrected = [];
  for (const doc of docs) {
    const key = doc.correspondent?.name || '(no supplier)';
    if (!bySupplier.has(key)) bySupplier.set(key, { name: key, correspondentId: doc.correspondent?.id ?? null, documents: 0, fields: blank() });
    const s = bySupplier.get(key);
    s.documents += 1;
    const fields = doc.readingOutcome?.fields || {};
    const wrong = [];
    for (const f of HEADER_FIELDS) {
      const o = fields[f];
      if (!o) continue;
      overall[f][o] += 1;
      s.fields[f][o] += 1;
      if (o === 'corrected' || o === 'filled') wrong.push(f);
    }
    if (wrong.length) corrected.push({ paperlessId: doc.paperlessId, title: doc.title || null, supplier: key, fields: wrong });
  }
  const rate = (c) => {
    const tried = c.matched + c.corrected + c.filled + c.missed;
    return tried ? Math.round((c.matched / tried) * 100) : null;
  };
  return {
    documents: docs.length,
    overall: Object.fromEntries(HEADER_FIELDS.map((f) => [f, { ...overall[f], rate: rate(overall[f]) }])),
    suppliers: [...bySupplier.values()]
      .map((s) => ({ ...s, fields: Object.fromEntries(HEADER_FIELDS.map((f) => [f, { ...s.fields[f], rate: rate(s.fields[f]) }])) }))
      .sort((a, b) => b.documents - a.documents),
    corrected: corrected.slice(-100).reverse(),
  };
}

/**
 * A saved invoice as a test fixture: its text, and what was saved. For
 * tests/fixtures/invoices/, which the reader's tests run against.
 */
export async function fixtureFor(paperlessId, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, DocumentText } = d.m;
  const doc = await OcrDocument.findOne({ paperlessId }).select('paperlessId correspondent entry').lean();
  if (!doc?.entry) return null;
  let text = await DocumentText.findOne({ paperlessId }).lean();
  if (!text) {
    await readDocument(paperlessId, deps);
    text = await DocumentText.findOne({ paperlessId }).lean();
  }
  if (!text) return null;
  const lines = (doc.entry.lines || []).map((l) => ({ description: l.description, quantity: l.quantity, price: l.price, total: l.total, vatRate: l.vatRate }));
  return {
    paperlessId: doc.paperlessId,
    supplier: doc.correspondent?.name || null,
    readerVersion: READER_VERSION,
    pageWidth: text.pageWidth,
    expected: { ...savedValues(doc.entry), lines },
    items: text.items,
  };
}

// ── Teaching the reader about a supplier ─────────────────────────────

const MAX_LABELS = 10;

/** Label words as typed: one per line or comma, trimmed, de-duplicated, sane length. */
export function cleanLabels(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]/);
  const seen = new Set();
  return list.map((p) => String(p).trim().replace(/\s+/g, ' '))
    .filter((p) => p.length >= 2 && p.length <= 60)
    .filter((p) => (seen.has(p.toLowerCase()) ? false : seen.add(p.toLowerCase())))
    .slice(0, MAX_LABELS);
}

/** A spot someone pointed at: it goes first, ahead of anything learned from saves. */
export function teachSpots(spots = {}, field, box, now = new Date()) {
  const list = (spots[field] || []).filter((s) => !(s.page === box.page && Math.hypot(s.x + s.w - (box.x + box.w), s.y - box.y) <= SAME_SPOT));
  const top = Math.max(0, ...list.map((s) => s.seen || 0));
  const taught = { page: box.page, x: r1(box.x), y: r1(box.y), w: r1(box.w), h: r1(box.h), seen: top + 5, lastAt: now, taught: true };
  return { ...spots, [field]: [taught, ...list].slice(0, SPOTS_KEPT) };
}

const validBox = (b) => !!b && [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(Number(n)))
  && Number.isInteger(Number(b.page)) && Number(b.page) >= 1 && Number(b.w) > 0 && Number(b.h) > 0;

/** Everything the supplier page shows: what's learned, label words, recent invoices. */
export async function supplierDetail(correspondentId, deps = {}) {
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const { OcrDocument, SupplierLayout, DocumentText } = d.m;
  const id = Number(correspondentId);
  const [layout, docs] = await Promise.all([
    SupplierLayout.findOne({ correspondentId: id }).lean(),
    OcrDocument.find({ 'correspondent.id': id, processingState: { $ne: null }, deletedInPaperlessAt: null })
      .select('paperlessId title correspondent added processingState readingOutcome reading.fields reading.hasText')
      .sort({ added: -1 }).limit(15).lean(),
  ]);
  if (!layout && !docs.length) return null;
  const withText = [];
  for (const doc of docs) {
    if (await DocumentText?.findOne({ paperlessId: doc.paperlessId }).select('paperlessId').lean()) withText.push(doc.paperlessId);
  }
  return {
    correspondentId: id,
    name: layout?.correspondentName || docs[0]?.correspondent?.name || `Supplier ${id}`,
    invoicesLearned: layout?.invoicesLearned || 0,
    spots: layout?.spots || {},
    labels: layout?.labels || {},
    updatedAt: layout?.updatedAt || null,
    documents: docs.map((doc) => ({ ...doc, hasText: withText.includes(doc.paperlessId) })),
  };
}

async function updateLayout(d, id, name, change) {
  const { SupplierLayout } = d.m;
  const existing = await SupplierLayout.findOne({ correspondentId: id }).lean();
  const next = change(existing || { spots: {}, labels: {} });
  await SupplierLayout.updateOne(
    { correspondentId: id },
    { $set: { correspondentName: name || existing?.correspondentName || null, spots: next.spots || {}, labels: next.labels || {} } },
    { upsert: true },
  );
  return next;
}

/** "This is where the invoice total is": point at a value on one of the supplier's invoices. */
export async function teach(correspondentId, field, box, { name = null } = {}, deps = {}) {
  if (!HEADER_FIELDS.includes(field)) return { ok: false, message: 'Unknown field.' };
  if (!validBox(box)) return { ok: false, message: 'That spot is not on the page.' };
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const clean = { page: Number(box.page), x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) };
  const next = await updateLayout(d, Number(correspondentId), name, (l) => ({ ...l, spots: teachSpots(l.spots || {}, field, clean, d.now()) }));
  return { ok: true, spots: next.spots[field] };
}

/** Forget what was learned for one field, or for everything (spots and label words). */
export async function forget(correspondentId, field = null, deps = {}) {
  if (field && !HEADER_FIELDS.includes(field)) return { ok: false, message: 'Unknown field.' };
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const id = Number(correspondentId);
  if (!field) {
    await d.m.SupplierLayout.updateOne({ correspondentId: id }, { $set: { spots: {}, labels: {}, invoicesLearned: 0 } });
    return { ok: true };
  }
  await updateLayout(d, id, null, (l) => {
    const spots = { ...(l.spots || {}) };
    delete spots[field];
    return { ...l, spots };
  });
  return { ok: true };
}

/** Set the label words for one field of a supplier. Empty clears them. */
export async function setLabels(correspondentId, field, input, { name = null } = {}, deps = {}) {
  if (!HEADER_FIELDS.includes(field)) return { ok: false, message: 'Unknown field.' };
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  const phrases = cleanLabels(input);
  await updateLayout(d, Number(correspondentId), name, (l) => {
    const labels = { ...(l.labels || {}) };
    if (phrases.length) labels[field] = phrases;
    else delete labels[field];
    return { ...l, labels };
  });
  return { ok: true, labels: phrases };
}

/** Ask Paperless to OCR a document again (for PDFs with no text layer). */
export async function reprocess(paperlessId, deps = {}) {
  const client = deps.client || __paperlessClient.makeClient();
  await client.reprocessDocuments([paperlessId]);
  // Its text changes once Paperless is done; read it again then
  const d = withDeps(deps);
  if (d.connect) await d.connect();
  await d.m.DocumentText?.deleteOne({ paperlessId });
  await d.m.OcrDocument?.updateOne({ paperlessId }, { $unset: { reading: 1 } });
  return { ok: true };
}

export default {
  READER_VERSION, HEADER_FIELDS, extractItems, summarise, packItem, unpackItem,
  layoutFromSpots, mergeSpots, savedValues, compareReading,
  supplierFor, vatCheck, duplicatesOf,
  readDocument, readSoon, readMissing, learnFromSave, layoutFor, hintsFor, insights, accuracyReport, fixtureFor, reprocess,
  cleanLabels, teachSpots, supplierDetail, teach, forget, setLabels,
};
