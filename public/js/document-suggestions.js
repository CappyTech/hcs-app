/**
 * "Here's what I think the invoice number is" on the document entry screen.
 *
 * When the viewer has the PDF open, this reads its text (with positions) and
 * guesses the invoice number, dates, totals and line items
 * (invoice-field-finder.js, invoice-line-finder.js). Then:
 *   - draws a box on the PDF around the text each guess came from;
 *   - under each field, says what the document says, with a "Use" button, or
 *     that the typed value matches it; a due date the invoice doesn't print is
 *     worked out from its payment terms ("STRICTLY 30 DAYS");
 *   - offers to fill the line items, and checks lines, VAT and totals add up
 *     as you type;
 *   - lists where the Paperless custom fields and the document disagree;
 *   - with a field focused, clicking a value on the PDF fills it in;
 *   - asks the server whether the VAT number is the supplier's and whether
 *     the invoice number is already in KashFlow or on another document, and
 *     reads with the layout learned from this supplier's earlier invoices.
 *
 * Nothing is saved: everything only fills inputs, and the person still saves.
 * Hooks into document-viewer.js through its hcs:pdf-loaded / hcs:pdf-page
 * events, so it never touches rendering or text selection.
 */
import { findFields, locateValue, normalise, toItems, charBox, fitBox, FIELDS } from '/resources/js/invoice-field-finder.js';
import { findLines, fillMissingRates, findPaymentTerms, findVatNumbers } from '/resources/js/invoice-line-finder.js';
import { liveChecks, pickValue } from '/resources/js/entry-checks.js';

const MAX_PAGES = 5; // invoices put these on the first page or two
const PREF_KEY = 'hcs.entry.highlights';
const LINE_FIELDS = ['description', 'quantity', 'price', 'total', 'vatRate'];
const LINE_LABEL = { description: 'description', quantity: 'quantity', price: 'price', total: 'total', vatRate: 'VAT %' };

const root = document.getElementById('pdf-viewer');
const form = document.querySelector('[data-suggest-form]');
const toggle = document.getElementById('pdf-highlights-toggle');
const fillAllBtn = document.getElementById('suggest-fill-all');
const fillLinesBtn = document.getElementById('suggest-fill-lines');
const linesBox = form?.querySelector('[data-lines]');
const checksBox = form?.querySelector('[data-suggest-checks]');
const disagreeBox = form?.querySelector('[data-suggest-disagree]');
const insightsBox = form?.querySelector('[data-suggest-insights]');
const paperlessId = form?.dataset.paperlessId;
// Where this supplier's earlier invoices had each field (learned on save)
const layout = (() => { try { return JSON.parse(form?.dataset.layout || '{}'); } catch { return {}; } })();
const pickStatus = document.getElementById('pdf-pick-status');
const inputs = Object.fromEntries(
  [...document.querySelectorAll('[data-suggest-field]')].map((el) => [el.dataset.suggestField, el]),
);
const TYPE = Object.fromEntries(FIELDS.map((f) => [f.field, f.type]));
const LABEL = Object.fromEntries(FIELDS.map((f) => [f.field, f.label]));
// What Paperless had put in the form, before anyone typed
const fromPaperless = form?.dataset.valuesSource === 'paperless'
  ? Object.fromEntries(Object.entries(inputs).map(([f, el]) => [f, el.value.trim()]))
  : null;

let items = [];
let guesses = {}; // field → guess from the finder
let terms = null; // payment terms, for a due date the invoice doesn't print
let docLines = []; // line items read off the document
const pages = new Map(); // pageNumber → { pageEl, viewport, layer }
let active = null; // key of the lit-up box: a field name or "line:N"

const readPref = () => { try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; } };
const writePref = (on) => { try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* private mode */ } };
let showMarks = readPref();

const money = (v) => `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shown = (field, value) => {
  if (TYPE[field] === 'money') return money(value);
  if (TYPE[field] === 'date') {
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  }
  return value;
};
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const icon = (name) => el('i', { className: `bi bi-${name}` });
const setValue = (input, value) => {
  input.value = value ?? '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

/** The guess for a field, including a due date worked out from the payment terms. */
function guessFor(field) {
  if (field === 'dueDate' && !guesses.dueDate && terms) {
    const invoiceDate = inputs.invoiceDate?.value || guesses.invoiceDate?.value;
    const t = findPaymentTerms(items, invoiceDate);
    if (t?.dueDate) return { value: t.dueDate, page: t.page, box: t.box, derived: t.text };
  }
  return guesses[field] || null;
}

// ── Boxes on the PDF ─────────────────────────────────────────────────

/** Where to draw a field's box: its guess, or where the typed value is on the page. */
function markFor(field) {
  const typed = inputs[field]?.value?.trim();
  const g = guessFor(field);
  if (typed && (!g || normalise(TYPE[field], typed) !== normalise(TYPE[field], g.value))) {
    const at = locateValue(items, field, typed);
    if (at) return at;
  }
  return g;
}

function allMarks() {
  const out = [];
  for (const field of Object.keys(inputs)) {
    const m = markFor(field);
    if (m) out.push({ key: field, label: m.derived ? `${LABEL[field]} (from terms)` : LABEL[field], page: m.page, box: m.box });
  }
  docLines.forEach((l, i) => out.push({ key: `line:${i}`, label: `Line ${i + 1}`, page: l.page, box: l.box, line: true }));
  return out;
}

/**
 * A box around part of a text item, placed by real character widths. The
 * text layer draws each item as a span stretched over the printed text, so a
 * Range over the first n characters of that span measures them. (Font names
 * can't be used for this: PDF.js substitutes fonts under other names.)
 */
function exactBox(box, p) {
  const src = box?.src;
  if (!src || (src.from === 0 && src.to === src.str.length)) return box;
  // The span for this item: same text, nearest to where the item is
  const [ax, ay] = p.viewport.convertToViewportPoint(src.x, box.y + box.h);
  const pageRect = p.pageEl.getBoundingClientRect();
  let span = null;
  let best = Infinity;
  for (const s of p.pageEl.querySelectorAll('.textLayer span')) {
    if (s.textContent !== src.str) continue;
    const r = s.getBoundingClientRect();
    const d = Math.hypot(r.left - pageRect.left - ax, r.top - pageRect.top - ay);
    if (d < best) { best = d; span = s; }
  }
  const text = span?.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE || best > 40) return box;
  const range = document.createRange();
  const left = span.getBoundingClientRect().left;
  // Width of the span's first n characters: fitBox only ever measures prefixes
  const measure = (t) => {
    if (t.length === 0) return 0;
    range.setStart(text, 0);
    range.setEnd(text, Math.min(t.length, text.length));
    return range.getBoundingClientRect().right - left;
  };
  return fitBox(box, measure);
}

function drawPage(pageNumber) {
  const p = pages.get(pageNumber);
  if (!p) return;
  p.layer?.remove();
  const layer = el('div', { className: 'hcs-pdf-marks', hidden: !showMarks });
  p.layer = layer;
  for (const m of allMarks()) {
    if (m.page !== pageNumber) continue;
    const box = exactBox(m.box, p);
    // PDF.js 6 has no convertToViewportRectangle; two corners do the same
    const [x1, y1] = p.viewport.convertToViewportPoint(box.x, box.y);
    const [x2, y2] = p.viewport.convertToViewportPoint(box.x + box.w, box.y + box.h);
    const pad = 2;
    const mark = el('div', { className: `hcs-pdf-mark${m.line ? ' is-line' : ''}` }, el('span', { className: 'hcs-pdf-mark-tag', textContent: m.label }));
    mark.dataset.key = m.key;
    mark.style.left = `${Math.min(x1, x2) - pad}px`;
    mark.style.top = `${Math.min(y1, y2) - pad}px`;
    mark.style.width = `${Math.abs(x2 - x1) + pad * 2}px`;
    mark.style.height = `${Math.abs(y2 - y1) + pad * 2}px`;
    layer.append(mark);
  }
  p.pageEl.append(layer);
  setActive(active, { scroll: false });
}

const drawAll = () => { for (const n of pages.keys()) drawPage(n); };

function setActive(key, { scroll = true } = {}) {
  active = key;
  for (const layer of root.querySelectorAll('.hcs-pdf-marks')) layer.classList.toggle('is-dimmed', !!key);
  let target = null;
  for (const m of root.querySelectorAll('.hcs-pdf-mark')) {
    const on = m.dataset.key === key;
    m.classList.toggle('is-active', on);
    if (on) target = m;
  }
  if (scroll && target && showMarks) {
    // Scroll the viewer only, not the whole page
    const box = target.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (box.top < view.top + 24 || box.bottom > view.bottom - 24) {
      root.scrollBy({ top: box.top - view.top - view.height / 3, behavior: 'smooth' });
    }
  }
}

// ── Hints under the header fields ────────────────────────────────────

const HINT_BASE = 'mt-1 text-xs flex flex-wrap items-center gap-x-2 gap-y-1';

function useButton(label, onUse, text = 'Use') {
  const b = el('button', {
    type: 'button',
    className: 'px-2 py-0.5 rounded-md border border-current font-medium hover:bg-white/60 dark:hover:bg-black/20',
    textContent: text,
  });
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onUse);
  return b;
}

const useField = (field, value) => useButton(`Use ${shown(field, value)} for ${LABEL[field].toLowerCase()}`, () => {
  setValue(inputs[field], value);
  inputs[field].focus();
});

function renderHint(field) {
  const hint = form?.querySelector(`[data-suggest-for="${field}"]`);
  const input = inputs[field];
  if (!hint || !input) return;
  const g = guessFor(field);
  const typed = input.value.trim();
  hint.replaceChildren();
  hint.hidden = true;
  if (!g) {
    if (typed && locateValue(items, field, typed)) {
      hint.className = `${HINT_BASE} text-gray-500 dark:text-gray-400`;
      hint.append(el('span', { textContent: 'Found on the document.' }));
      hint.hidden = false;
    }
    return;
  }
  const same = typed && normalise(TYPE[field], typed) === normalise(TYPE[field], g.value);
  const note = g.derived ? ` (worked out from “${g.derived}”)` : g.page > 1 ? ` (page ${g.page})` : '';
  if (same) {
    hint.className = `${HINT_BASE} text-green-700 dark:text-green-400`;
    hint.append(el('span', {}, icon('check2'), ` Matches the document${note}`));
  } else {
    const colour = typed ? 'text-amber-700 dark:text-amber-400' : 'text-blue-700 dark:text-blue-400';
    hint.className = `${HINT_BASE} ${colour}`;
    hint.append(el('span', {}, icon(typed ? 'exclamation-triangle' : 'stars'), ' Document says ', el('strong', { textContent: shown(field, g.value) }), note));
    if (!input.disabled) hint.append(useField(field, g.value));
  }
  hint.hidden = false;
}

function renderFillAll() {
  if (!fillAllBtn) return;
  const empty = Object.keys(inputs).filter((f) => guessFor(f) && !inputs[f].value.trim() && !inputs[f].disabled);
  fillAllBtn.hidden = empty.length < 2;
  fillAllBtn.querySelector('[data-count]')?.replaceChildren(String(empty.length));
  fillAllBtn.onclick = () => { for (const f of empty) setValue(inputs[f], guessFor(f).value); };
}

/** Where the Paperless custom fields and the document disagree (PB: fields keyed before hcs-app). */
function renderDisagreements() {
  if (!disagreeBox || !fromPaperless) return;
  const rows = Object.keys(inputs).filter((f) => {
    const g = guessFor(f);
    const now = inputs[f].value.trim();
    return g && fromPaperless[f] && now === fromPaperless[f] && normalise(TYPE[f], now) !== normalise(TYPE[f], g.value);
  });
  disagreeBox.replaceChildren();
  disagreeBox.hidden = !rows.length;
  if (!rows.length) return;
  disagreeBox.className = 'border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1';
  disagreeBox.append(el('p', { className: 'font-medium' }, icon('exclamation-triangle-fill'), ' The Paperless fields and the document disagree'));
  const list = el('ul', { className: 'space-y-1' });
  for (const f of rows) {
    const g = guessFor(f);
    list.append(el('li', { className: 'flex flex-wrap items-center gap-x-2' },
      el('span', {}, `${LABEL[f]}: Paperless `, el('strong', { textContent: shown(f, normalise(TYPE[f], fromPaperless[f]) ?? fromPaperless[f]) }), ', document ', el('strong', { textContent: shown(f, g.value) })),
      inputs[f].disabled ? null : useField(f, g.value)));
  }
  disagreeBox.append(list);
  if (rows.length > 1 && !inputs[rows[0]].disabled) {
    disagreeBox.append(useButton('Use the document for all of these', () => { for (const f of rows) setValue(inputs[f], guessFor(f).value); }, 'Use the document for all'));
  }
}

// ── Line items ───────────────────────────────────────────────────────

const lineBlocks = () => [...(linesBox?.querySelectorAll('[data-line]') || [])];
const lineInput = (block, f) => block.querySelector(`[name$="[${f}]"]`);
const formLines = () => lineBlocks().map((b) => Object.fromEntries(LINE_FIELDS.map((f) => [f, lineInput(b, f)?.value.trim() ?? ''])));
const lineIsBlank = (l) => LINE_FIELDS.every((f) => !l[f]);

/** Another line block, copied from the last and renumbered. */
function addLineBlock() {
  const blocks = lineBlocks();
  const last = blocks.at(-1);
  const i = blocks.length;
  const copy = last.cloneNode(true);
  copy.dataset.line = String(i);
  copy.querySelector('[data-line-label]').textContent = `Line ${i + 1}`;
  for (const input of copy.querySelectorAll('input')) {
    input.name = input.name.replace(/^lines\[\d+\]/, `lines[${i}]`);
    input.setAttribute('aria-label', (input.getAttribute('aria-label') || '').replace(/^Line \d+/, `Line ${i + 1}`));
    input.value = '';
    // A copied error highlight would point at the wrong line
    input.className = input.className.replace('border-red-400 dark:border-red-600', 'border-gray-300 dark:border-gray-600');
  }
  last.after(copy);
  wireLineBlock(copy);
  return copy;
}

const cell = (v, dp) => (v == null ? '' : dp == null ? String(v) : Number(v).toFixed(dp));

function fillLines() {
  while (lineBlocks().length < docLines.length) addLineBlock();
  lineBlocks().forEach((b, i) => {
    const l = docLines[i];
    // Blank leftover rows: a blank row is how a line is removed on save
    setValue(lineInput(b, 'description'), l ? l.description : '');
    setValue(lineInput(b, 'quantity'), l ? cell(l.quantity) : '');
    setValue(lineInput(b, 'price'), l ? cell(l.price) : '');
    setValue(lineInput(b, 'total'), l ? cell(l.total, 2) : '');
    setValue(lineInput(b, 'vatRate'), l ? cell(l.vatRate) : '');
  });
  renderLinesButton();
}

function renderLinesButton() {
  if (!fillLinesBtn) return;
  const typed = formLines().filter((l) => !lineIsBlank(l));
  const same = typed.length === docLines.length
    && typed.every((l, i) => Math.abs(Number(l.total) - docLines[i].total) < 0.005);
  fillLinesBtn.hidden = !docLines.length || same;
  const n = docLines.length;
  fillLinesBtn.querySelector('[data-label]').textContent = typed.length
    ? `Replace with the ${n} line${n === 1 ? '' : 's'} on the document`
    : `Fill ${n} line${n === 1 ? '' : 's'} from the document`;
}

function renderChecks() {
  if (!checksBox) return;
  const header = Object.fromEntries(Object.entries(inputs).map(([f, i]) => [f, i.value.trim()]));
  const problems = liveChecks(header, formLines());
  checksBox.replaceChildren();
  checksBox.hidden = !problems.length;
  if (!problems.length) return;
  checksBox.append(el('p', { className: 'font-medium mb-1' }, icon('exclamation-triangle-fill'), ' These don’t add up yet'));
  checksBox.append(el('ul', { className: 'list-disc ml-5 space-y-0.5' }, ...problems.map((p) => el('li', { textContent: p }))));
}

function wireLineBlock(block) {
  block.addEventListener('focusin', () => {
    const i = lineBlocks().indexOf(block);
    if (docLines[i]) setActive(`line:${i}`);
  });
  block.addEventListener('focusout', () => setActive(null, { scroll: false }));
}

// ── Click a value on the PDF to fill the focused field ───────────────

let armed = null; // { input, field, label } waiting for a click on the PDF
let refocusing = false;

function describeInput(input) {
  if (input.dataset.suggestField) return { field: input.dataset.suggestField, label: LABEL[input.dataset.suggestField] };
  const m = input.name.match(/^lines\[(\d+)\]\[(\w+)\]$/);
  if (m) return { field: `line.${m[2]}`, label: `line ${Number(m[1]) + 1} ${LINE_LABEL[m[2]] || m[2]}` };
  return null;
}

function arm(input) {
  const d = describeInput(input);
  if (!d || input.disabled || !items.length) return;
  armed = { input, ...d };
  root.classList.add('is-picking');
  if (pickStatus) {
    pickStatus.replaceChildren(icon('cursor'), el('span', {}, 'Click a value on the document to fill ', el('strong', { textContent: d.label }), '.'),
      el('span', { className: 'ml-auto opacity-70', textContent: 'Esc to stop' }));
    pickStatus.hidden = false;
  }
}

function disarm() {
  armed = null;
  root.classList.remove('is-picking');
  if (pickStatus) pickStatus.hidden = true;
}

function itemAt(pageNumber, x, y) {
  let best = null;
  for (const it of items) {
    if (it.page !== pageNumber) continue;
    const b = charBox(it);
    if (x < b.x - 1 || x > b.x + b.w + 1 || y < b.y || y > b.y + b.h) continue;
    if (!best || b.w * b.h < best.w * best.h) best = { it, w: b.w, h: b.h };
  }
  return best?.it || null;
}

function onPdfClick(e) {
  if (!armed) return;
  if (String(window.getSelection?.() || '').trim()) return; // they're selecting text, not picking
  const pageEl = e.target.closest('.hcs-pdf-page');
  const entry = [...pages.entries()].find(([, p]) => p.pageEl === pageEl);
  if (!entry) return;
  const [pageNumber, p] = entry;
  const rect = pageEl.getBoundingClientRect();
  const [x, y] = p.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
  const it = itemAt(pageNumber, x, y);
  if (!it) return;
  // The character under the pointer: exactly, from the text layer span that was
  // clicked, or else by its share of the item's width
  const caret = e.target.closest?.('.textLayer span')?.textContent === it.str
    ? (document.caretPositionFromPoint?.(e.clientX, e.clientY)?.offset ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset)
    : null;
  const guess = Math.floor(((x - it.x) / (it.w || 1)) * it.str.length);
  const at = Math.max(0, Math.min(it.str.length - 1, caret ?? guess));
  const start = it.str.lastIndexOf(' ', at) + 1;
  const end = it.str.indexOf(' ', at);
  const word = it.str.slice(start, end < 0 ? undefined : end);
  const value = pickValue(armed.field, it.str, word);
  if (value == null) {
    pickStatus?.replaceChildren(icon('x-circle'), el('span', { textContent: `That isn't a ${armed.label.replace(/^line \d+ /, '')}. Try another value, or Esc to stop.` }));
    return;
  }
  const { input } = armed;
  setValue(input, value);
  disarm();
  refocusing = true;
  input.focus(); // Tab on to the next field, click the document again
  refocusing = false;
  input.classList.add('hcs-just-filled');
  setTimeout(() => input.classList.remove('hcs-just-filled'), 900);
}

// ── Supplier VAT number and duplicates (server) ──────────────────────

let vatNumbers = [];
let insightsTimer = null;
let insightsAsked = 0;

const fmtVat = (n) => (n ? `GB ${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7, 9)}${n.length > 9 ? ` ${n.slice(9)}` : ''}` : '');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB') : null);

async function fetchInsights() {
  if (!insightsBox || !paperlessId) return;
  const ask = ++insightsAsked;
  const q = new URLSearchParams();
  const number = inputs.invoiceNumber?.value.trim() || guesses.invoiceNumber?.value || '';
  if (number) q.set('invoiceNumber', number);
  if (vatNumbers.length) q.set('vat', vatNumbers.join(','));
  try {
    const res = await fetch(`/paperless/ocr/${encodeURIComponent(paperlessId)}/insights?${q}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok || ask !== insightsAsked) return; // a newer question is on its way
    renderInsights(await res.json());
  } catch {
    /* the checks are extras; the form works without them */
  }
}

function renderInsights(ins) {
  const notes = [];
  const supplier = ins.supplier?.name;
  if (ins.vat?.status === 'mismatch') {
    const owners = ins.vat.belongsTo?.length ? ` It's ${ins.vat.belongsTo.map((b) => b.name).join(' or ')}'s.` : '';
    notes.push(['warn', `The VAT number on the invoice (${ins.vat.found.map(fmtVat).join(', ')}) isn't ${supplier}'s (${fmtVat(ins.vat.supplierVat)}).${owners} Check the supplier is right.`]);
  } else if (ins.vat?.status === 'no_supplier' && ins.vat.found?.length) {
    notes.push(['info', "No KashFlow supplier has exactly this correspondent's name, so the VAT number can't be checked."]);
  } else if (ins.vat?.status === 'supplier_has_none' && ins.vat.found?.length) {
    notes.push(['info', `KashFlow has no VAT number for ${supplier}. The invoice shows ${ins.vat.found.map(fmtVat).join(', ')}.`]);
  }
  for (const p of ins.duplicates?.kashflow || []) {
    notes.push(['danger', `Invoice ${p.reference} from ${p.supplier || supplier || 'this supplier'} is already in KashFlow as purchase ${p.number}${p.date ? ` (${fmtDate(p.date)})` : ''}${p.gross != null ? `, ${money(p.gross)}` : ''}.`]);
  }
  for (const d of ins.duplicates?.documents || []) {
    notes.push(['warn', el('span', {}, 'The same invoice number is on another document: ',
      el('a', { href: `/paperless/ocr/${d.paperlessId}/entry`, className: 'underline', textContent: d.title || `#${d.paperlessId}` }),
      d.state === 'sent' ? ' (in KashFlow).' : '.')]);
  }
  insightsBox.replaceChildren();
  insightsBox.hidden = !notes.length;
  if (!notes.length) return;
  const STYLE = {
    danger: 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300',
    warn: 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300',
    info: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300',
  };
  const ICON = { danger: 'exclamation-octagon-fill', warn: 'exclamation-triangle-fill', info: 'info-circle' };
  insightsBox.className = 'space-y-2';
  for (const [kind, text] of notes) {
    insightsBox.append(el('div', { className: `border rounded-xl p-3 text-xs ${STYLE[kind]}` }, icon(ICON[kind]), ' ', typeof text === 'string' ? el('span', { textContent: text }) : text));
  }
}

const insightsSoon = () => {
  clearTimeout(insightsTimer);
  insightsTimer = setTimeout(fetchInsights, 500);
};

// ── Wiring ───────────────────────────────────────────────────────────

const renderHints = () => {
  Object.keys(inputs).forEach(renderHint);
  renderFillAll();
  renderDisagreements();
};

async function readDocument(pdf) {
  const n = Math.min(pdf.numPages, MAX_PAGES);
  let width = 595;
  const all = [];
  for (let i = 1; i <= n; i++) {
    const page = await pdf.getPage(i);
    if (i === 1) width = page.getViewport({ scale: 1 }).width;
    const tc = await page.getTextContent();
    all.push(...toItems(tc.items, i));
  }
  return { all, width };
}

if (root && form && Object.keys(inputs).length) {
  root.addEventListener('hcs:pdf-loaded', async (e) => {
    try {
      const { all, width } = await readDocument(e.detail.pdf);
      items = all;
      guesses = Object.fromEntries(Object.entries(findFields(items, { pageWidth: width, layout })).filter(([f, g]) => g && inputs[f]));
      vatNumbers = findVatNumbers(items).map((v) => v.number);
      terms = findPaymentTerms(items);
      docLines = fillMissingRates(findLines(items), guesses.totalGoods?.value, guesses.totalVat?.value);
      renderHints();
      renderLinesButton();
      renderChecks();
      drawAll();
      if (toggle) toggle.hidden = !allMarks().length;
      root.dispatchEvent(new CustomEvent('hcs:document-read', { detail: { items, guesses, lines: docLines, terms } }));
      fetchInsights();
    } catch (err) {
      console.error('[document-suggestions]', err);
    }
  });

  root.addEventListener('hcs:pdf-page', (e) => {
    const { pageNumber, pageEl, viewport } = e.detail;
    pages.set(pageNumber, { pageEl, viewport, layer: null });
    if (items.length) drawPage(pageNumber);
  });

  root.addEventListener('click', onPdfClick);

  for (const [field, input] of Object.entries(inputs)) {
    input.addEventListener('focus', () => setActive(field));
    input.addEventListener('blur', () => setActive(null, { scroll: false }));
    input.addEventListener('input', () => {
      renderHint(field);
      if (field === 'invoiceDate') renderHint('dueDate'); // due date from terms follows it
      if (field === 'invoiceNumber') insightsSoon(); // is the new number a duplicate?
      renderFillAll();
      renderDisagreements();
      drawAll();
      if (markFor(field) && document.activeElement === input) setActive(field);
    });
    const hint = form.querySelector(`[data-suggest-for="${field}"]`);
    hint?.addEventListener('mouseenter', () => setActive(field));
    hint?.addEventListener('mouseleave', () => { if (document.activeElement !== input) setActive(null, { scroll: false }); });
  }
  lineBlocks().forEach(wireLineBlock);

  // Arm click-to-fill on whichever field has focus; keep it armed when the
  // click on the PDF takes the focus away
  form.addEventListener('focusin', (e) => {
    if (refocusing || !(e.target instanceof HTMLInputElement)) return;
    if (describeInput(e.target)) arm(e.target);
    else disarm();
  });
  form.addEventListener('input', () => { renderLinesButton(); renderChecks(); });
  form.addEventListener('submit', disarm);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) disarm(); });
  document.addEventListener('mousedown', (e) => {
    if (armed && !root.contains(e.target) && !form.contains(e.target)) disarm();
  });

  fillLinesBtn?.addEventListener('click', fillLines);

  if (toggle) {
    const sync = () => {
      toggle.setAttribute('aria-pressed', String(showMarks));
      toggle.classList.toggle('is-on', showMarks);
      for (const layer of root.querySelectorAll('.hcs-pdf-marks')) layer.hidden = !showMarks;
    };
    toggle.addEventListener('click', () => { showMarks = !showMarks; writePref(showMarks); sync(); });
    sync();
  }
}
