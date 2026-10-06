/**
 * "Here's what I think the invoice number is" on the document entry screen.
 *
 * When the viewer has the PDF open, this reads its text (with positions),
 * guesses the invoice number, dates and totals (invoice-field-finder.js),
 * and then:
 *   - draws a labelled box on the PDF around the text each guess came from;
 *   - under each form field, says what the document seems to say, with a
 *     "Use" button, or that the typed value matches it;
 *   - focusing or hovering a field lights its box up and scrolls to it.
 *
 * Nothing is saved: Use only fills the input, and the person still saves.
 * Hooks into document-viewer.js through its hcs:pdf-loaded / hcs:pdf-page
 * events, so it never touches rendering or text selection.
 */
import { findFields, locateValue, normalise, toItems, fitBox, FIELDS } from '/resources/js/invoice-field-finder.js';

const MAX_PAGES = 5; // invoices put these on the first page or two
const PREF_KEY = 'hcs.entry.highlights';

const root = document.getElementById('pdf-viewer');
const form = document.querySelector('[data-suggest-form]');
const toggle = document.getElementById('pdf-highlights-toggle');
const fillAllBtn = document.getElementById('suggest-fill-all');
const inputs = Object.fromEntries(
  [...document.querySelectorAll('[data-suggest-field]')].map((el) => [el.dataset.suggestField, el]),
);
const TYPE = Object.fromEntries(FIELDS.map((f) => [f.field, f.type]));
const LABEL = Object.fromEntries(FIELDS.map((f) => [f.field, f.label]));

let items = [];
let guesses = {}; // field → guess from the finder
const pages = new Map(); // pageNumber → { pageEl, viewport, layer }
let active = null;

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

/** What box to show for a field: the guess, or where the typed value is on the page. */
function markFor(field) {
  const input = inputs[field];
  const typed = input?.value?.trim();
  const g = guesses[field];
  if (typed && (!g || normalise(TYPE[field], typed) !== normalise(TYPE[field], g.value))) {
    const at = locateValue(items, field, typed);
    if (at) return { ...at, kind: 'typed' };
  }
  return g ? { ...g, kind: 'guess' } : null;
}

// ── PDF boxes ────────────────────────────────────────────────────────

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
  const layer = document.createElement('div');
  layer.className = 'hcs-pdf-marks';
  layer.hidden = !showMarks;
  p.layer = layer;
  for (const field of Object.keys(inputs)) {
    const m = markFor(field);
    if (!m || m.page !== pageNumber) continue;
    const box = exactBox(m.box, p);
    // PDF.js 6 has no convertToViewportRectangle; two corners do the same
    const [x1, y1] = p.viewport.convertToViewportPoint(box.x, box.y);
    const [x2, y2] = p.viewport.convertToViewportPoint(box.x + box.w, box.y + box.h);
    const pad = 2;
    const el = document.createElement('div');
    el.className = 'hcs-pdf-mark';
    el.dataset.field = field;
    el.style.left = `${Math.min(x1, x2) - pad}px`;
    el.style.top = `${Math.min(y1, y2) - pad}px`;
    el.style.width = `${Math.abs(x2 - x1) + pad * 2}px`;
    el.style.height = `${Math.abs(y2 - y1) + pad * 2}px`;
    const tag = document.createElement('span');
    tag.className = 'hcs-pdf-mark-tag';
    tag.textContent = LABEL[field];
    el.append(tag);
    layer.append(el);
  }
  p.pageEl.append(layer);
  setActive(active, { scroll: false });
}

const drawAll = () => { for (const n of pages.keys()) drawPage(n); };

function setActive(field, { scroll = true } = {}) {
  active = field;
  for (const layer of root.querySelectorAll('.hcs-pdf-marks')) layer.classList.toggle('is-dimmed', !!field);
  let target = null;
  for (const el of root.querySelectorAll('.hcs-pdf-mark')) {
    const on = el.dataset.field === field;
    el.classList.toggle('is-active', on);
    if (on) target = el;
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

// ── Hints under the fields ───────────────────────────────────────────

const HINT_BASE = 'mt-1 text-xs flex flex-wrap items-center gap-x-2 gap-y-1';

function useButton(field, value) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'px-2 py-0.5 rounded-md border border-current font-medium hover:bg-white/60 dark:hover:bg-black/20';
  b.textContent = 'Use';
  b.setAttribute('aria-label', `Use ${shown(field, value)} for ${LABEL[field].toLowerCase()}`);
  b.addEventListener('click', () => {
    const input = inputs[field];
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  return b;
}

function renderHint(field) {
  const hint = form?.querySelector(`[data-suggest-for="${field}"]`);
  const input = inputs[field];
  if (!hint || !input) return;
  const g = guesses[field];
  const typed = input.value.trim();
  hint.replaceChildren();
  hint.hidden = true;
  if (!g) {
    if (typed && locateValue(items, field, typed)) {
      hint.className = `${HINT_BASE} text-gray-500 dark:text-gray-400`;
      hint.append(Object.assign(document.createElement('span'), { textContent: 'Found on the document.' }));
      hint.hidden = false;
    }
    return;
  }
  const same = typed && normalise(TYPE[field], typed) === normalise(TYPE[field], g.value);
  const text = document.createElement('span');
  const pageNote = g.page > 1 ? ` (page ${g.page})` : '';
  if (same) {
    hint.className = `${HINT_BASE} text-green-700 dark:text-green-400`;
    text.innerHTML = '<i class="bi bi-check2"></i> ';
    text.append(`Matches the document${pageNote}`);
    hint.append(text);
  } else if (!typed) {
    hint.className = `${HINT_BASE} text-blue-700 dark:text-blue-400`;
    text.innerHTML = '<i class="bi bi-stars"></i> ';
    text.append('Document says ');
    text.append(Object.assign(document.createElement('strong'), { textContent: shown(field, g.value) }));
    text.append(pageNote);
    hint.append(text);
    if (!input.disabled) hint.append(useButton(field, g.value));
  } else {
    hint.className = `${HINT_BASE} text-amber-700 dark:text-amber-400`;
    text.innerHTML = '<i class="bi bi-exclamation-triangle"></i> ';
    text.append('Document says ');
    text.append(Object.assign(document.createElement('strong'), { textContent: shown(field, g.value) }));
    text.append(pageNote);
    hint.append(text);
    if (!input.disabled) hint.append(useButton(field, g.value));
  }
  hint.hidden = false;
}

function renderFillAll() {
  if (!fillAllBtn) return;
  const empty = Object.keys(inputs).filter((f) => guesses[f] && !inputs[f].value.trim() && !inputs[f].disabled);
  fillAllBtn.hidden = empty.length < 2;
  fillAllBtn.querySelector('[data-count]')?.replaceChildren(String(empty.length));
  fillAllBtn.onclick = () => {
    for (const f of empty) {
      inputs[f].value = guesses[f].value;
      inputs[f].dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
}

const renderHints = () => { Object.keys(inputs).forEach(renderHint); renderFillAll(); };

// ── Wiring ───────────────────────────────────────────────────────────

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
      guesses = Object.fromEntries(Object.entries(findFields(items, { pageWidth: width })).filter(([f, g]) => g && inputs[f]));
      renderHints();
      drawAll();
      if (toggle) toggle.hidden = !Object.keys(inputs).some((f) => markFor(f));
    } catch (err) {
      console.error('[document-suggestions]', err);
    }
  });

  root.addEventListener('hcs:pdf-page', (e) => {
    const { pageNumber, pageEl, viewport } = e.detail;
    pages.set(pageNumber, { pageEl, viewport, layer: null });
    if (items.length) drawPage(pageNumber);
  });

  for (const [field, input] of Object.entries(inputs)) {
    input.addEventListener('focus', () => setActive(field));
    input.addEventListener('blur', () => setActive(null, { scroll: false }));
    input.addEventListener('input', () => {
      renderHint(field);
      renderFillAll();
      const m = markFor(field);
      // The typed value may now point at a different spot on the page
      for (const n of pages.keys()) drawPage(n);
      if (m) setActive(field);
    });
    const hint = form.querySelector(`[data-suggest-for="${field}"]`);
    hint?.addEventListener('mouseenter', () => setActive(field));
    hint?.addEventListener('mouseleave', () => { if (document.activeElement !== input) setActive(null, { scroll: false }); });
  }

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
