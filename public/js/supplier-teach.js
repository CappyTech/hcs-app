/**
 * The supplier reading page (/paperless/reading/supplier/:id): shows on one of
 * the supplier's invoices where hcs-app has learned each field sits, and lets
 * someone point a field out by hand.
 *
 * "Point it out" → click the value on the invoice → the spot is saved for this
 * supplier (POST …/teach) and the reader prefers a value there from then on.
 * Hooks into document-viewer.js through its hcs:pdf-loaded / hcs:pdf-page events.
 */
import { toItems, charBox, FIELDS } from '/resources/js/invoice-field-finder.js';
import { pickValue } from '/resources/js/entry-checks.js';
import { exactBox, placeBox, clickTarget } from '/resources/js/pdf-marks.js';

const MAX_PAGES = 5;
const root = document.getElementById('pdf-viewer');
const host = document.querySelector('[data-supplier-teach]');
const pickStatus = document.getElementById('pdf-pick-status');
const LABEL = Object.fromEntries(FIELDS.map((f) => [f.field, f.label]));
const parseJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const correspondentId = host?.dataset.correspondentId;
const supplierName = host?.dataset.name || '';
let spots = parseJson(host?.dataset.spots);
let items = [];
const pages = new Map(); // pageNumber → { pageEl, viewport, layer }
let armed = null; // field waiting for a click on the invoice
let active = null;

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const icon = (name) => el('i', { className: `bi bi-${name}` });

// ── Drawing what's learned ───────────────────────────────────────────

function drawPage(pageNumber) {
  const p = pages.get(pageNumber);
  if (!p) return;
  p.layer?.remove();
  const layer = el('div', { className: 'hcs-pdf-marks' });
  p.layer = layer;
  for (const [field, list] of Object.entries(spots)) {
    const s = list?.[0];
    if (!s || s.page !== pageNumber) continue;
    const mark = el('div', { className: 'hcs-pdf-mark' }, el('span', { className: 'hcs-pdf-mark-tag', textContent: LABEL[field] || field }));
    mark.dataset.key = field;
    Object.assign(mark.style, placeBox(s, p));
    layer.append(mark);
  }
  p.pageEl.append(layer);
  setActive(active, { scroll: false });
}
const drawAll = () => { for (const n of pages.keys()) drawPage(n); };

function setActive(field, { scroll = true } = {}) {
  active = field;
  for (const layer of root.querySelectorAll('.hcs-pdf-marks')) layer.classList.toggle('is-dimmed', !!field);
  let target = null;
  for (const m of root.querySelectorAll('.hcs-pdf-mark')) {
    const on = m.dataset.key === field;
    m.classList.toggle('is-active', on);
    if (on) target = m;
  }
  if (scroll && target) {
    const box = target.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (box.top < view.top + 24 || box.bottom > view.bottom - 24) {
      root.scrollBy({ top: box.top - view.top - view.height / 3, behavior: 'smooth' });
    }
  }
}

// ── Pointing a field out ─────────────────────────────────────────────

function status(...kids) {
  if (!pickStatus) return;
  pickStatus.replaceChildren(...kids);
  pickStatus.hidden = !kids.length;
}

function arm(field) {
  if (!items.length) {
    status(icon('hourglass-split'), el('span', { textContent: 'Still reading this invoice. Try again in a moment.' }));
    return;
  }
  armed = field;
  root.classList.add('is-picking');
  status(icon('cursor'), el('span', {}, 'Click the ', el('strong', { textContent: LABEL[field].toLowerCase() }), ` on this invoice.`),
    el('span', { className: 'ml-auto opacity-70', textContent: 'Esc to stop' }));
}

function disarm() {
  armed = null;
  root.classList.remove('is-picking');
  status();
}

/** The value clicked, and the box around just that value. */
function valueClicked(field, hit) {
  const { item, word, wordFrom, wordTo } = hit;
  const whole = pickValue(field, item.str);
  if (whole != null) return { value: whole, box: charBox(item) };
  const part = pickValue(field, null, word);
  if (part != null) return { value: part, box: charBox(item, wordFrom, wordTo) };
  return null;
}

async function onPdfClick(e) {
  if (!armed) return;
  if (String(window.getSelection?.() || '').trim()) return; // selecting text, not pointing
  const hit = clickTarget(e, items, pages);
  if (!hit) return;
  const field = armed;
  const got = valueClicked(field, hit);
  if (!got) {
    status(icon('x-circle'), el('span', { textContent: `That isn't a ${LABEL[field].toLowerCase()}. Try another value, or Esc to stop.` }));
    return;
  }
  const { page, x, y, w, h } = exactBox(got.box, hit.page);
  status(icon('hourglass-split'), el('span', { textContent: 'Saving…' }));
  try {
    const res = await fetch(`/paperless/reading/supplier/${encodeURIComponent(correspondentId)}/teach`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '',
      },
      body: JSON.stringify({ field, box: { page, x, y, w, h }, name: supplierName }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.message || `HTTP ${res.status}`);
    spots = { ...spots, [field]: body.spots };
    disarm();
    drawAll();
    setActive(field);
    const text = host.querySelector(`[data-field-card="${field}"] [data-spot-text]`);
    text?.replaceChildren(icon('check2'), ` Pointed out by hand just now (${got.value}). Invoices from ${supplierName} are read from there first.`);
    text?.classList.add('text-green-700', 'dark:text-green-400');
  } catch (err) {
    status(icon('x-circle'), el('span', { textContent: `Couldn't save that: ${err.message}` }));
  }
}

async function readDocument(pdf) {
  const all = [];
  for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
    const page = await pdf.getPage(i);
    all.push(...toItems((await page.getTextContent()).items, i));
  }
  return all;
}

if (root && host) {
  root.addEventListener('hcs:pdf-loaded', async (e) => {
    try {
      items = await readDocument(e.detail.pdf);
    } catch (err) {
      console.error('[supplier-teach]', err);
    }
  });
  root.addEventListener('hcs:pdf-page', (e) => {
    const { pageNumber, pageEl, viewport } = e.detail;
    pages.set(pageNumber, { pageEl, viewport, layer: null });
    drawPage(pageNumber);
  });
  root.addEventListener('click', onPdfClick);
  for (const btn of host.querySelectorAll('[data-teach-field]')) {
    btn.addEventListener('click', () => (armed === btn.dataset.teachField ? disarm() : arm(btn.dataset.teachField)));
  }
  for (const card of host.querySelectorAll('[data-field-card]')) {
    card.addEventListener('mouseenter', () => setActive(card.dataset.fieldCard));
    card.addEventListener('mouseleave', () => setActive(null, { scroll: false }));
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) disarm(); });
}
