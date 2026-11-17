// An .xlsx upload as plain rows, for the workbook imports (Job Register,
// weekly attendance sheet).
//
// Each sheet comes back as { name, rows, fills }, rows being arrays indexed from 0
// (column A is rows[r][0]). Cell values are flattened to what the sheet
// shows: formulas give their cached result, rich text its plain text, and
// dates a 'yyyy-mm-dd' string marked as a date ({ date: 'yyyy-mm-dd' }), so
// the parsers never deal with time zones or Excel serials.
import ExcelJS from 'exceljs';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const XLSX_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const DAY_MS = 864e5;

/** A JS Date from ExcelJS (UTC, possibly a hair off midnight) as its calendar day. */
export function dayOf(date) {
  const t = date.getTime();
  if (Number.isNaN(t)) return null;
  return new Date(Math.round(t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** One ExcelJS cell value, flattened. */
export function flattenValue(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const d = dayOf(v);
    return d ? { date: d } : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text || '').join('');
    if ('result' in v) return flattenValue(v.result);
    if ('formula' in v || 'sharedFormula' in v) return null;
    if ('text' in v) return flattenValue(v.text);
    if ('error' in v) return null;
  }
  return null;
}

// ── Fill colours ────────────────────────────────────────────────────────
//
// The Job Reg workbook marks each row's state with a background colour, so
// the reader also gives each cell's fill as a plain colour name: 'white',
// 'grey', 'black', 'red', 'orange', 'yellow', 'green', 'blue' or 'purple'
// (null for no fill). Theme colours are looked up in the workbook's theme
// (Office's default palette when it has none) and their tint applied.

// Excel's theme colour index → the theme's colour names (lt1/dk1 and lt2/dk2 swap)
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
const OFFICE_THEME = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31',
  accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47',
};
// Excel's legacy indexed colours that turn up as fills
const INDEXED = { 2: 'FF0000', 3: '00FF00', 5: 'FFFF00', 10: 'FF0000', 13: 'FFFF00', 22: 'C0C0C0', 23: '808080', 43: 'FFCC00', 50: '99CC00', 51: 'FFCC00', 52: 'FF9900', 53: 'FF6600' };

/** The theme palette ({ dk1: 'RRGGBB', … }) from a theme part's XML, over Office's defaults. */
export function themePalette(xml) {
  const out = { ...OFFICE_THEME };
  for (const name of Object.keys(OFFICE_THEME)) {
    const m = String(xml || '').match(new RegExp(`<a:${name}>\\s*<a:(?:srgbClr val|sysClr[^>]*lastClr)="([0-9A-Fa-f]{6})"`));
    if (m) out[name] = m[1].toUpperCase();
  }
  return out;
}

/** Excel's tint (-1…1) applied to an RRGGBB colour, as [r, g, b]. */
function tinted(hex, tint = 0) {
  return [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(tint < 0 ? c * (1 + tint) : c + (255 - c) * tint);
  });
}

/** [r, g, b] as a colour name. */
export function colourName([r, g, b]) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const light = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
  if (sat < 0.15 || max - min < 0.08) return light > 0.85 ? 'white' : light < 0.3 ? 'black' : 'grey';
  const d = max - min;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  let hue = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 43) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 170) return 'green';
  if (hue < 260) return 'blue';
  return 'purple';
}

/** An ExcelJS cell fill as a colour name, or null when the cell isn't filled. */
export function fillColour(fill, palette = OFFICE_THEME) {
  if (!fill || fill.type !== 'pattern' || !fill.pattern || fill.pattern === 'none') return null;
  const c = fill.fgColor || {};
  let hex = null;
  if (typeof c.argb === 'string' && /^[0-9A-Fa-f]{8}$/.test(c.argb)) hex = c.argb.slice(2);
  else if (Number.isInteger(c.theme)) hex = palette[THEME_ORDER[c.theme]] || null;
  else if (Number.isInteger(c.indexed)) hex = INDEXED[c.indexed] || null;
  if (!hex) return null;
  return colourName(tinted(hex.toUpperCase(), Number(c.tint) || 0));
}

/** Is this upload plausibly an .xlsx? (multer fileFilter) */
export function isXlsxUpload(file) {
  return /\.xlsx$/i.test(String(file?.originalname || '')) && XLSX_MIME.has(String(file?.mimetype || ''));
}

/**
 * Every sheet of an .xlsx buffer as { name, rows, fills }. fills[r][c] is
 * the fill colour name of rows[r][c] (null for none). Throws a 400 when it
 * can't be read.
 */
export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw Object.assign(new Error("That file couldn't be read as an Excel workbook (.xlsx)."), { status: 400, cause: err });
  }
  const palette = themePalette(Object.values(wb._themes || {})[0]);
  return wb.worksheets.map((ws) => {
    const rows = [];
    const fills = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[rowNumber - 1] = values.map(flattenValue);
      const colours = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { colours[col - 1] = fillColour(cell.fill, palette); });
      fills[rowNumber - 1] = Array.from(colours, (c) => c ?? null);
    });
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = [];
      if (!fills[i]) fills[i] = [];
    }
    return { name: ws.name, rows, fills };
  });
}

export default { MAX_UPLOAD_BYTES, dayOf, flattenValue, isXlsxUpload, readWorkbook, themePalette, colourName, fillColour };
