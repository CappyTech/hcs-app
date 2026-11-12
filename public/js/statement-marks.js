/**
 * The supplier statement entry screen: boxes on the PDF around each statement
 * line that was read (green matched, amber amount differs, red not in
 * KashFlow), and pointing out the statement's columns for its supplier.
 *
 * The lines, their boxes and their outcome come from the server's reading
 * (statementReadingService, stored on the document), so nothing is read here
 * except the text under a click. "Reference column" → click its heading (or a
 * value in it) on the PDF → POST …/statement-layout → the statement is read
 * again with it, and the page reloads to show the new result.
 *
 * Hooks into document-viewer.js through its hcs:pdf-loaded / hcs:pdf-page
 * events, like document-suggestions.js and supplier-teach.js.
 */
import { toItems, charBox } from '/resources/js/invoice-field-finder.js';
import { placeBox, exactBox, clickTarget } from '/resources/js/pdf-marks.js';

const MAX_PAGES = 12;
const PREF_KEY = 'hcs.entry.highlights';
const root = document.getElementById('pdf-viewer');
const data = document.querySelector('[data-statement-marks]');
const teach = document.querySelector('[data-statement-teach]');
const toggle = document.getElementById('pdf-highlights-toggle');
const pickStatus = document.getElementById('pdf-pick-status');
const parseJson = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

const lineMarks = parseJson(data?.dataset.statementMarks);
const columnMarks = parseJson(data?.dataset.statementColumns);
const paperlessId = teach?.dataset.paperlessId;
const pages = new Map(); // pageNumber → { pageEl, viewport, layer }
let items = [];
let active = null;
let armed = null; // { role, label } waiting for a click on the PDF

const readPref = () => { try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; } };
const writePref = (on) => { try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* private mode */ } };
let showMarks = readPref();

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const icon = (name) => el('i', { className: `bi bi-${name}` });

// ── Boxes ────────────────────────────────────────────────────────────

// Column headings are shown while the Columns panel is open
const showColumns = () => Boolean(teach?.open);

function drawPage(pageNumber) {
  const p = pages.get(pageNumber);
  if (!p) return;
  p.layer?.remove();
  const layer = el('div', { className: 'hcs-pdf-marks', hidden: !showMarks && !armed });
  p.layer = layer;
  const marks = [
    ...lineMarks.map((m) => ({ ...m, cls: `is-line is-stmt-${m.tone}` })),
    ...(showColumns() ? columnMarks.map((m) => ({ ...m, cls: 'is-stmt-column' })) : []),
  ];
  for (const m of marks) {
    if (m.box?.page !== pageNumber) continue;
    const mark = el('div', { className: `hcs-pdf-mark ${m.cls}` }, el('span', { className: 'hcs-pdf-mark-tag', textContent: m.label }));
    mark.dataset.key = m.key;
    mark.title = m.label;
    Object.assign(mark.style, placeBox(m.box, p));
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
    const box = target.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (box.top < view.top + 24 || box.bottom > view.bottom - 24) {
      root.scrollBy({ top: box.top - view.top - view.height / 3, behavior: 'smooth' });
    }
  }
}

// ── Pointing out a column ────────────────────────────────────────────

function status(...kids) {
  if (!pickStatus) return;
  pickStatus.replaceChildren(...kids);
  pickStatus.hidden = !kids.length;
}
const teachStatus = (text, tone = 'gray') => {
  const p = teach?.querySelector('[data-teach-status]');
  if (!p) return;
  p.className = tone === 'red' ? 'text-red-700 dark:text-red-400' : 'text-gray-600 dark:text-gray-300';
  p.textContent = text;
  p.hidden = !text;
};

function arm(role, label) {
  if (!items.length) {
    status(icon('hourglass-split'), el('span', { textContent: 'Still reading this statement. Try again in a moment.' }));
    return;
  }
  armed = { role, label };
  root.classList.add('is-picking');
  for (const b of teach.querySelectorAll('[data-teach-role]')) b.setAttribute('aria-pressed', String(b.dataset.teachRole === role));
  status(icon('cursor'), el('span', {}, 'Click the ', el('strong', { textContent: label }), ' column’s heading on the statement, or any value in it.'),
    el('span', { className: 'ml-auto opacity-70', textContent: 'Esc to stop' }));
  drawAll();
}

function disarm() {
  armed = null;
  root?.classList.remove('is-picking');
  for (const b of teach?.querySelectorAll('[data-teach-role]') || []) b.setAttribute('aria-pressed', 'false');
  status();
}

async function send(body) {
  const res = await fetch(`/paperless/ocr/${encodeURIComponent(paperlessId)}/statement-layout`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || '',
    },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.message || `HTTP ${res.status}`);
  return out;
}

/** Saved: the statement was read again on the server, so show the new reading. */
const reload = () => window.location.reload();

async function onPdfClick(e) {
  if (!armed) return;
  if (String(window.getSelection?.() || '').trim()) return; // selecting text, not pointing
  const hit = clickTarget(e, items, pages);
  if (!hit) return;
  const { role, label } = armed;
  // A heading is taken whole ("Document Reference"); a value just the word clicked
  const isHeading = !/\d/.test(hit.item.str);
  const box = exactBox(isHeading ? charBox(hit.item) : charBox(hit.item, hit.wordFrom, hit.wordTo), hit.page);
  status(icon('hourglass-split'), el('span', { textContent: 'Saving and checking again…' }));
  try {
    await send({ role, box: { page: box.page, x: box.x, y: box.y, w: box.w, h: box.h }, label: isHeading ? hit.item.str.trim() : null });
    disarm();
    status(icon('check2'), el('span', { textContent: `Remembered the ${label} column. Checking again…` }));
    reload();
  } catch (err) {
    status(icon('x-circle'), el('span', { textContent: `Couldn't save that: ${err.message}` }));
  }
}

async function readItems(pdf) {
  const all = [];
  for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
    const page = await pdf.getPage(i);
    all.push(...toItems((await page.getTextContent()).items, i));
  }
  return all;
}

if (root && data) {
  root.addEventListener('hcs:pdf-loaded', async (e) => {
    try {
      items = await readItems(e.detail.pdf);
    } catch (err) {
      console.error('[statement-marks]', err);
    }
  });
  root.addEventListener('hcs:pdf-page', (e) => {
    const { pageNumber, pageEl, viewport } = e.detail;
    pages.set(pageNumber, { pageEl, viewport, layer: null });
    drawPage(pageNumber);
  });
  root.addEventListener('click', onPdfClick);

  // Hovering a row of the reconciliation lights its line on the PDF
  for (const tr of document.querySelectorAll('[data-statement-line]')) {
    const key = `line:${tr.dataset.statementLine}`;
    if (!lineMarks.some((m) => m.key === key)) continue;
    tr.classList.add('cursor-pointer');
    tr.addEventListener('mouseenter', () => setActive(key));
    tr.addEventListener('mouseleave', () => setActive(null, { scroll: false }));
  }

  if (toggle && (lineMarks.length || columnMarks.length)) {
    toggle.hidden = false;
    const sync = () => {
      toggle.setAttribute('aria-pressed', String(showMarks));
      toggle.classList.toggle('is-on', showMarks);
      for (const layer of root.querySelectorAll('.hcs-pdf-marks')) layer.hidden = !showMarks && !armed;
    };
    toggle.addEventListener('click', () => { showMarks = !showMarks; writePref(showMarks); sync(); });
    sync();
  }

  if (teach) {
    teach.addEventListener('toggle', drawAll);
    for (const b of teach.querySelectorAll('[data-teach-role]')) {
      b.addEventListener('click', () => (armed?.role === b.dataset.teachRole ? disarm() : arm(b.dataset.teachRole, b.dataset.label)));
    }
    for (const b of teach.querySelectorAll('[data-teach-kind]')) {
      b.addEventListener('click', async () => {
        teachStatus('Saving and checking again…');
        try { await send({ kind: b.dataset.teachKind }); reload(); } catch (err) { teachStatus(`Couldn't save that: ${err.message}`, 'red'); }
      });
    }
    teach.querySelector('[data-teach-forget]')?.addEventListener('click', async () => {
      teachStatus('Forgetting and checking again…');
      try { await send({ forget: true }); reload(); } catch (err) { teachStatus(`Couldn't forget that: ${err.message}`, 'red'); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) { disarm(); drawAll(); } });
  }
}
