/**
 * Shared by the scripts that draw on the PDF viewer (document-suggestions.js
 * on the entry screen, supplier-teach.js on the supplier reading page): fit a
 * box to the real characters, and find what was clicked.
 *
 * `p` is a page as the viewer reports it in its hcs:pdf-page event:
 * { pageEl, viewport }.
 */
import { charBox, fitBox } from '/resources/js/invoice-field-finder.js';

/**
 * A box around part of a text item, placed by real character widths. The
 * text layer draws each item as a span stretched over the printed text, so a
 * Range over the first n characters of that span measures them. (Font names
 * can't be used for this: PDF.js substitutes fonts under other names.)
 */
export function exactBox(box, p) {
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

/** A box (PDF units) as CSS left/top/width/height on its page, padded a little. */
export function placeBox(box, p, pad = 2) {
  // PDF.js 6 has no convertToViewportRectangle; two corners do the same
  const [x1, y1] = p.viewport.convertToViewportPoint(box.x, box.y);
  const [x2, y2] = p.viewport.convertToViewportPoint(box.x + box.w, box.y + box.h);
  return {
    left: `${Math.min(x1, x2) - pad}px`,
    top: `${Math.min(y1, y2) - pad}px`,
    width: `${Math.abs(x2 - x1) + pad * 2}px`,
    height: `${Math.abs(y2 - y1) + pad * 2}px`,
  };
}

/** The smallest text item under a point (PDF units) on a page. */
export function itemAt(items, pageNumber, x, y) {
  let best = null;
  for (const it of items) {
    if (it.page !== pageNumber) continue;
    const b = charBox(it);
    if (x < b.x - 1 || x > b.x + b.w + 1 || y < b.y || y > b.y + b.h) continue;
    if (!best || b.w * b.h < best.w * best.h) best = { it, w: b.w, h: b.h };
  }
  return best?.it || null;
}

/**
 * What a click on the PDF landed on: the page, the text item, and the word
 * under the pointer (exactly, from the text layer, when the click was on it).
 * @returns {{pageNumber, page, item, word, wordFrom, wordTo}|null}
 */
export function clickTarget(e, items, pages) {
  const pageEl = e.target.closest?.('.hcs-pdf-page');
  const entry = [...pages.entries()].find(([, p]) => p.pageEl === pageEl);
  if (!entry) return null;
  const [pageNumber, page] = entry;
  const rect = pageEl.getBoundingClientRect();
  const [x, y] = page.viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
  const item = itemAt(items, pageNumber, x, y);
  if (!item) return null;
  const caret = e.target.closest?.('.textLayer span')?.textContent === item.str
    ? (document.caretPositionFromPoint?.(e.clientX, e.clientY)?.offset ?? document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset)
    : null;
  const guess = Math.floor(((x - item.x) / (item.w || 1)) * item.str.length);
  const at = Math.max(0, Math.min(item.str.length - 1, caret ?? guess));
  const wordFrom = item.str.lastIndexOf(' ', at) + 1;
  const end = item.str.indexOf(' ', at);
  const wordTo = end < 0 ? item.str.length : end;
  return { pageNumber, page, item, word: item.str.slice(wordFrom, wordTo), wordFrom, wordTo };
}

export default { exactBox, placeBox, itemAt, clickTarget };
