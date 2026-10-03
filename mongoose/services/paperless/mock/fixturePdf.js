/**
 * Builds small, real PDFs for the mock Paperless client from a document's
 * fixture text, so the H5 viewer can render them and copy text out of their
 * text layer without any supplier document being committed to the repo
 * (PAPERLESS-MIGRATION.md section 6a).
 *
 * One A4 page, Helvetica, one line of text per line of `content`. The text is
 * real PDF text (not an image), which is what a Paperless-OCR'd file has.
 */

const escapePdfText = (s) => String(s)
  // Helvetica's standard encoding has no characters outside Latin-1
  .replace(/[^\x20-\x7e£]/g, '?')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)');

/** @param {string} content - newline-separated text @returns {Buffer} */
export function buildFixturePdf(content) {
  const lines = String(content || '').split(/\r?\n/).slice(0, 50);
  const text = ['BT', '/F1 12 Tf', '14 TL', '56 780 Td']
    .concat(lines.map((l) => `(${escapePdfText(l)}) '`))
    .concat('ET')
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export default { buildFixturePdf };
