// An .xlsx upload as plain rows, for the workbook imports (Job Register,
// weekly attendance sheet).
//
// Each sheet comes back as { name, rows }, rows being arrays indexed from 0
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

/** Is this upload plausibly an .xlsx? (multer fileFilter) */
export function isXlsxUpload(file) {
  return /\.xlsx$/i.test(String(file?.originalname || '')) && XLSX_MIME.has(String(file?.mimetype || ''));
}

/** Every sheet of an .xlsx buffer as { name, rows }. Throws a 400 when it can't be read. */
export async function readWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw Object.assign(new Error("That file couldn't be read as an Excel workbook (.xlsx)."), { status: 400, cause: err });
  }
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows[rowNumber - 1] = values.map(flattenValue);
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return { name: ws.name, rows };
  });
}

export default { MAX_UPLOAD_BYTES, dayOf, flattenValue, isXlsxUpload, readWorkbook };
