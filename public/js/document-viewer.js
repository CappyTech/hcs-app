/**
 * PDF viewer for the document entry screen (Paperless migration H5).
 *
 * Renders every page of the PDF at #pdf-viewer[data-src] with PDF.js, with a
 * text layer over each page so text can be selected and copied straight out
 * of the invoice. The file comes from hcs-app's own proxy route, so the
 * browser never talks to Paperless. Loaded as a module from the view; the
 * page's CSP forbids inline scripts.
 */
import * as pdfjsLib from '/resources/vendor/pdfjs/pdf.min.mjs';

const VENDOR = '/resources/vendor/pdfjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}/pdf.worker.min.mjs`;

const root = document.getElementById('pdf-viewer');
const pagesEl = document.getElementById('pdf-pages');
const statusEl = document.getElementById('pdf-status');
const zoomLabel = document.getElementById('pdf-zoom-label');

let pdf = null;
let zoom = 1; // relative to fit-to-width
let renderToken = 0;

const setStatus = (text) => {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.hidden = !text;
};

async function renderAll() {
  if (!pdf) return;
  const token = ++renderToken;
  pagesEl.replaceChildren();
  const width = Math.max(pagesEl.clientWidth - 2, 200);

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    if (token !== renderToken) return; // a newer render started
    const base = page.getViewport({ scale: 1 });
    const scale = (width / base.width) * zoom;
    const viewport = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;

    const pageEl = document.createElement('div');
    pageEl.className = 'hcs-pdf-page';
    pageEl.style.width = `${Math.floor(viewport.width)}px`;
    pageEl.style.height = `${Math.floor(viewport.height)}px`;
    pageEl.style.setProperty('--scale-factor', String(scale));
    pageEl.style.setProperty('--user-unit', '1');
    pageEl.style.setProperty('--total-scale-factor', 'calc(var(--scale-factor) * var(--user-unit))');
    pageEl.style.setProperty('--scale-round-x', '1px');
    pageEl.style.setProperty('--scale-round-y', '1px');

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);

    const textLayerEl = document.createElement('div');
    textLayerEl.className = 'textLayer';

    pageEl.append(canvas, textLayerEl);
    pagesEl.append(pageEl);

    await page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();
  }
  if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

async function load() {
  if (!root || !pagesEl) return;
  setStatus('Loading document…');
  try {
    pdf = await pdfjsLib.getDocument({
      url: root.dataset.src,
      withCredentials: true,
      isEvalSupported: false,
      cMapUrl: `${VENDOR}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}/standard_fonts/`,
      iccUrl: `${VENDOR}/iccs/`,
    }).promise;
    setStatus('');
    await renderAll();
  } catch (err) {
    console.error('[document-viewer]', err);
    setStatus('The document could not be shown here. Use "Open in Paperless" instead.');
  }
}

document.getElementById('pdf-zoom-in')?.addEventListener('click', () => { zoom = Math.min(zoom + 0.25, 3); renderAll(); });
document.getElementById('pdf-zoom-out')?.addEventListener('click', () => { zoom = Math.max(zoom - 0.25, 0.5); renderAll(); });
document.getElementById('pdf-zoom-fit')?.addEventListener('click', () => { zoom = 1; renderAll(); });

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderAll, 200);
});

load();
