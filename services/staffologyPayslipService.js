/**
 * staffologyPayslipService — fetch one payslip PDF from Staffology, on demand.
 *
 * hcs-app's own integration (it holds the key in Settings → Connections →
 * Staffology). Payslips are never stored or cached here: each view is a fresh
 * read-only call to Staffology's payslip report for one pay run entry,
 * streamed straight back to the browser.
 *
 *   GET /employers/{employerId}/reports/{Year2026}/{Weekly}/{period}/{payRunEntryId}/payslip?ordinal=N
 *   Accept: application/octet-stream  →  { content: <file name>, stream: <PDF bytes> }
 *
 * `stream` is handled whether it arrives base64-encoded, as a byte array, or
 * the response is the raw PDF itself.
 */
import axios from 'axios';
import configService from './configService.js';

const BASE = 'https://api.staffology.co.uk';
const auth = () => {
  const password = String(configService.get('STAFFOLOGY_API_KEY', '') || '').trim();
  if (!password) throw new Error('Staffology API key not configured.');
  return { username: 'hcs-app', password };
};

let cachedEmployer = null;

/** The configured employer ID, or the only one the key can see. */
export async function resolveEmployerId(http = axios) {
  const configured = String(configService.get('STAFFOLOGY_EMPLOYER_ID', '') || '').trim();
  if (configured) return configured;
  if (cachedEmployer) return cachedEmployer;
  const res = await http.get(`${BASE}/employers`, { auth: auth(), headers: { Accept: 'application/json' }, timeout: 15000 });
  const list = Array.isArray(res.data) ? res.data : [];
  if (list.length !== 1) throw new Error('Set the Staffology employer ID in Settings → Connections → Staffology.');
  cachedEmployer = list[0].id;
  return cachedEmployer;
}

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF';

/** Turn a Staffology payslip response body into PDF bytes (pure). */
export function decodePayslip(body) {
  if (body == null) return null;
  let data = body;
  if (data instanceof ArrayBuffer) data = Buffer.from(data);
  if (Buffer.isBuffer(data)) {
    if (isPdf(data)) return data;
    try { data = JSON.parse(data.toString('utf8')); } catch { return null; }
  }
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  const stream = data?.stream ?? data?.Stream;
  let bytes = null;
  if (typeof stream === 'string') bytes = Buffer.from(stream, 'base64');
  else if (Array.isArray(stream)) bytes = Buffer.from(stream);
  else if (stream?.type === 'Buffer' && Array.isArray(stream.data)) bytes = Buffer.from(stream.data);
  return isPdf(bytes) ? bytes : null;
}

const safeName = (s) => String(s || '').replace(/[^\w.\- ]+/g, '').trim();

/**
 * The PDF for one synced pay run entry.
 * @returns {Promise<{ pdf: Buffer, filename: string }>}
 */
export async function payslipFor(entry, http = axios) {
  if (!entry?.ExternalId || !entry.TaxYear || !entry.PayPeriod || !entry.Period) {
    throw new Error('This pay entry has no Staffology payslip reference.');
  }
  const employerId = await resolveEmployerId(http);
  const enc = encodeURIComponent;
  const url = `${BASE}/employers/${enc(employerId)}/reports/Year${enc(entry.TaxYear)}/${enc(entry.PayPeriod)}/${enc(entry.Period)}/${enc(entry.ExternalId)}/payslip`;
  let res;
  try {
    res = await http.get(url, {
      auth: auth(),
      headers: { Accept: 'application/octet-stream' },
      params: entry.Ordinal > 1 ? { ordinal: entry.Ordinal } : {},
      responseType: 'arraybuffer',
      timeout: 30000,
    });
  } catch (err) {
    const status = err?.response?.status;
    throw new Error(`Staffology could not provide this payslip${status ? ` (HTTP ${status})` : ''}.`);
  }
  const pdf = decodePayslip(res.data);
  if (!pdf) throw new Error('Staffology did not return a PDF payslip.');
  let filename = '';
  try { filename = safeName(JSON.parse(Buffer.from(res.data).toString('utf8'))?.content); } catch { /* raw PDF */ }
  if (!filename.toLowerCase().endsWith('.pdf')) filename = `payslip-${entry.TaxYear}-${entry.PayPeriod}-${entry.Period}.pdf`;
  return { pdf, filename };
}

export default { resolveEmployerId, decodePayslip, payslipFor };
