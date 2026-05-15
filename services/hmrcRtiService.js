'use strict';

/**
 * hmrcRtiService.js
 *
 * Generates PAYE-RTI XML (FPS and EPS) conformant with the HMRC RTI schema
 * and submits to the Government Gateway SOAP transaction engine.
 *
 * References:
 *   PAYE-RTI XSD: https://www.gov.uk/government/collections/rtipayroll
 *   Government Gateway (GG): https://www.gov.uk/government/publications/
 *     construction-industry-scheme-service-for-developers
 *
 * In production (NODE_ENV=production) the live GG URL is used.
 * In all other environments, the HMRC test URL is used automatically.
 */

const axios   = require('axios');
const os      = require('os');
const mdb     = require('../mongoose/services/mongooseDatabaseService');
const logger  = require('./loggerService');
const encSvc  = require('./encryptionService');

// ── Package version (used in Gov-Vendor-Version header) ───────────────────────
let _appVersion = '0.0.0';
try { _appVersion = require('../package.json').version; } catch { /* ignore */ }

// ── Persistent server device ID (stable across restarts) ─────────────────────
// Derived from the first non-internal MAC address; falls back to hostname hash.
function _deriveDeviceId() {
  try {
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const addr of iface) {
        if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
          return addr.mac.replace(/:/g, '').toLowerCase();
        }
      }
    }
  } catch { /* ignore */ }
  // Fallback: deterministic hash of hostname
  const h = os.hostname();
  let hash = 5381;
  for (let i = 0; i < h.length; i++) hash = ((hash << 5) + hash) ^ h.charCodeAt(i);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
const SERVER_DEVICE_ID = _deriveDeviceId();

// ── London UTC offset string (handles BST/GMT automatically) ─────────────────
function _londonOffset() {
  const now = new Date();
  const londonTime = new Date(now.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
  const utcTime    = new Date(now.toLocaleString('en-GB', { timeZone: 'UTC' }));
  const diffMins   = Math.round((londonTime - utcTime) / 60000);
  const sign       = diffMins >= 0 ? '+' : '-';
  const abs        = Math.abs(diffMins);
  const hh         = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm         = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Build the HMRC Fraud Prevention headers required on every GG submission.
 *
 * @param {object} context
 * @param {string} [context.clientIp]   – IP of the user who triggered the submission
 * @param {string} [context.userId]     – hcs-app username of the submitting user
 * @param {string} [context.serverIp]   – public IP of this server (optional)
 * @returns {object} Headers object ready to spread into axios config
 */
function buildFraudHeaders(context = {}) {
  const clientIp = context.clientIp || '0.0.0.0';
  const userId   = context.userId   || os.userInfo().username || 'system';
  const serverIp = context.serverIp || '0.0.0.0';

  return {
    'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER',
    'Gov-Client-Public-IP':         clientIp,
    'Gov-Client-User-IDs':          `{"os":${JSON.stringify(userId)}}`,
    'Gov-Client-Timezone':          _londonOffset(),
    'Gov-Client-Device-ID':         SERVER_DEVICE_ID,
    'Gov-Vendor-Version':           `{"hcs-app":${JSON.stringify(_appVersion)}}`,
    'Gov-Vendor-Public-IP':         serverIp,
  };
}

// ── Government Gateway endpoint ───────────────────────────────────────────────

const GG_LIVE_URL = 'https://www.tax.service.gov.uk/submission';
const GG_TEST_URL = 'https://test-transaction-engine.tax.service.gov.uk/submission';

function ggUrl() {
  return process.env.NODE_ENV === 'production' ? GG_LIVE_URL : GG_TEST_URL;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
  return Number(v) || 0;
}

function fmtMoney(v) { return toNum(v).toFixed(2); }
function fmtDate(d)  { return d instanceof Date ? d.toISOString().split('T')[0] : String(d || '').split('T')[0]; }

function xmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeDecrypt(enc) {
  if (!enc) return null;
  try { return encSvc.decrypt(enc); } catch { return null; }
}

/** Generate a pseudo-unique GG correlation ID */
function newCorrelationId() {
  const hex = () => Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
  return `PAY-${hex()}-${hex()}-${Date.now().toString(36).toUpperCase()}`;
}

// ── Load config + decrypt credentials ────────────────────────────────────────

async function loadConfig() {
  const PayrollConfig = mdb.INTERNAL?.payrollConfig;
  if (!PayrollConfig) throw new Error('Database not ready — payrollConfig model unavailable');
  const raw = await PayrollConfig.findOne().lean();
  if (!raw) throw new Error('Payroll config not found. Configure in Settings → Payroll.');
  return {
    payeRef:        safeDecrypt(raw.payeSchemeReference),
    accountsRef:    safeDecrypt(raw.accountsOfficeRef),
    gatewayUserId:  safeDecrypt(raw.gatewayUserId),
    gatewayPassword: safeDecrypt(raw.gatewayPassword),
    employerName:   raw.employerName || '',
    contactName:    raw.contactName  || '',
    contactPhone:   raw.contactPhone || ''
  };
}

// ── FPS XML generation ────────────────────────────────────────────────────────

/**
 * Builds a Full Payment Submission (FPS) XML string for all entries in a
 * locked payroll run.
 *
 * The FPS schema version is 2019 (FullPaymentSubmissionV0.3).
 *
 * @param {string} runUuid
 * @returns {Promise<Buffer>} UTF-8 encoded XML
 */
async function buildFPSForRun(runUuid) {
  const PayrollRun    = mdb.INTERNAL?.payrollRun;
  const PayrollEntry  = mdb.INTERNAL?.payrollEntry;
  if (!PayrollRun || !PayrollEntry) throw new Error('Database not ready');

  const run = await PayrollRun.findOne({ uuid: runUuid }).lean();
  if (!run) throw new Error(`Run not found: ${runUuid}`);
  if (run.status === 'draft') throw new Error('Run must be locked before generating FPS');

  const entries = await PayrollEntry.find({ runId: run._id })
    .populate('employeeId', 'name payroll uuid')
    .lean();

  const config = await loadConfig();
  if (!config.payeRef) throw new Error('PAYE scheme reference not configured');

  // Tax year in HMRC format: "25-26" for 2025/26
  const [fyStart, fyEnd2] = (run.taxYear || '').split('/');
  const hmrcTaxYear = `${fyStart.slice(-2)}-${fyEnd2}`;
  const paymentDate = fmtDate(run.paymentDate);

  // Split PAYE ref: "123/A12345" → officeNo="123", payeRef="A12345"
  const payeRefParts = (config.payeRef || '/').split('/');
  const officeNo     = payeRefParts[0] || '';
  const payeRefSufx  = payeRefParts.slice(1).join('/') || '';
  const payFreqCode  = run.frequency === 'monthly' ? 'M1'
                     : run.frequency === 'fortnightly' ? 'F2W'
                     : run.frequency === '4-weekly' ? 'W4'
                     : 'W1';

  let employeeXml = '';
  for (const entry of entries) {
    const emp = entry.employeeId || {};
    const payroll = emp.payroll || {};
    const niNum   = safeDecrypt(payroll.niNumber) || '';
    const taxCode = xmlEscape(entry.taxCode || payroll.taxCode || '1257L');
    const wk1Xml  = (entry.taxBasis === 'week1' || entry.taxBasis === 'month1')
      ? '<Wk1Mth1Ind>true</Wk1Mth1Ind>'
      : '';

    // Split name into fore/sur
    const nameParts = (emp.name || '').trim().split(' ');
    const foreName  = xmlEscape(nameParts.slice(0, -1).join(' ') || nameParts[0] || '');
    const surName   = xmlEscape(nameParts.length > 1 ? nameParts[nameParts.length - 1] : '');

    employeeXml += `
  <Employee>
    <EmployeeDetails>
      ${niNum ? `<NINO>${xmlEscape(niNum)}</NINO>` : ''}
      <Name>
        <Fore>${foreName}</Fore>
        <Sur>${surName}</Sur>
      </Name>
    </EmployeeDetails>
    <Employment>
      <SeqNum>1</SeqNum>
      <WorksNum>${xmlEscape(payroll.payrollId || emp.uuid?.slice(0, 8) || '')}</WorksNum>
      <PayFreq>${payFreqCode}</PayFreq>
      <PmtDate>${paymentDate}</PmtDate>
      ${run.taxMonth ? `<MonthNo>${run.taxMonth}</MonthNo>` : ''}
      ${run.taxWeek  ? `<WeekNo>${run.taxWeek}</WeekNo>` : ''}
      <TaxCd>${taxCode}</TaxCd>
      ${wk1Xml}
      <Payment>
        <TaxablePay>${fmtMoney(entry.taxableGross)}</TaxablePay>
        <TotalTax>${fmtMoney(entry.taxDeducted)}</TotalTax>
        <EEsNIInPayPd>${fmtMoney(entry.employeeNI)}</EEsNIInPayPd>
        <ERsNIInPayPd>${fmtMoney(entry.employerNI)}</ERsNIInPayPd>
        <EEsPenContribsInPayPd>${fmtMoney(entry.employeePension)}</EEsPenContribsInPayPd>
        <ERsPenContribsInPayPd>${fmtMoney(entry.employerPension)}</ERsPenContribsInPayPd>
        ${toNum(entry.studentLoanDeduction) > 0 ? `<SLDeductionInPayPd>${fmtMoney(entry.studentLoanDeduction)}</SLDeductionInPayPd>` : ''}
        ${toNum(entry.postgradLoanDeduction) > 0 ? `<PGLDeductionInPayPd>${fmtMoney(entry.postgradLoanDeduction)}</PGLDeductionInPayPd>` : ''}
      </Payment>
      <NIletter>
        <NIlettterCode>${xmlEscape(entry.niCategory || payroll.niCategory || 'A')}</NIlettterCode>
        <GrossEarningsForNI>
          <InPayPd>${fmtMoney(entry.grossPay)}</InPayPd>
          <ToDate>${fmtMoney(entry.ytdGrossPayAfter || entry.grossPay)}</ToDate>
        </GrossEarningsForNI>
        <EEsContribsInPayPd>${fmtMoney(entry.employeeNI)}</EEsContribsInPayPd>
        <EEsContribsYTD>${fmtMoney(entry.ytdEmployeeNIAfter)}</EEsContribsYTD>
        <ERsContribsInPayPd>${fmtMoney(entry.employerNI)}</ERsContribsInPayPd>
        <ERsContribsYTD>${fmtMoney(entry.ytdEmployerNIAfter)}</ERsContribsYTD>
      </NIletter>
      <TaxablePay_YTD>${fmtMoney(entry.ytdGrossPayAfter)}</TaxablePay_YTD>
      <TotalTax_YTD>${fmtMoney(entry.ytdTaxPaidAfter)}</TotalTax_YTD>
    </Employment>
  </Employee>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FullPaymentSubmission xmlns="http://www.govtalk.gov.uk/taxation/PAYE/RTI/FullPaymentSubmission/2019/04"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <EmpRefs>
    <OfficeNo>${xmlEscape(officeNo)}</OfficeNo>
    <PayeRef>${xmlEscape(payeRefSufx)}</PayeRef>
    <AORef>${xmlEscape(config.accountsRef || '')}</AORef>
  </EmpRefs>
  <RelatedTaxYear>${hmrcTaxYear}</RelatedTaxYear>
  ${employeeXml}
</FullPaymentSubmission>`;

  return Buffer.from(xml, 'utf-8');
}

// ── EPS XML generation ────────────────────────────────────────────────────────

/**
 * Builds an Employer Payment Summary (EPS) XML for a given tax year / month.
 * The EPS tells HMRC the total recoveries / nil payments for the period.
 *
 * @param {string} taxYear   e.g. '2025/26'
 * @param {number} taxMonth  1–12
 * @returns {Promise<Buffer>} UTF-8 encoded XML
 */
async function buildEPS(taxYear, taxMonth) {
  const PayrollRun = mdb.INTERNAL?.payrollRun;
  if (!PayrollRun) throw new Error('Database not ready');

  const config = await loadConfig();
  if (!config.payeRef) throw new Error('PAYE scheme reference not configured');

  const [fyStart, fyEnd2] = (taxYear || '').split('/');
  const hmrcTaxYear = `${fyStart.slice(-2)}-${fyEnd2}`;

  const payeRefParts = (config.payeRef || '/').split('/');
  const officeNo     = payeRefParts[0] || '';
  const payeRefSufx  = payeRefParts.slice(1).join('/') || '';

  // Aggregate all locked/submitted runs for this tax year + month
  const runs = await PayrollRun.find({
    taxYear,
    taxMonth: Number(taxMonth),
    status: { $in: ['locked', 'submitted'] }
  }).lean();

  let totalGross = 0, totalTax = 0, totalEmpNI = 0, totalErpNI = 0;
  for (const r of runs) {
    totalGross += toNum(r.totals?.grossPay);
    totalTax   += toNum(r.totals?.taxDeducted);
    totalEmpNI += toNum(r.totals?.employeeNI);
    totalErpNI += toNum(r.totals?.employerNI);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EmployerPaymentSummary xmlns="http://www.govtalk.gov.uk/taxation/PAYE/RTI/EmployerPaymentSummary/2019/04"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <EmpRefs>
    <OfficeNo>${xmlEscape(officeNo)}</OfficeNo>
    <PayeRef>${xmlEscape(payeRefSufx)}</PayeRef>
    <AORef>${xmlEscape(config.accountsRef || '')}</AORef>
  </EmpRefs>
  <RelatedTaxYear>${hmrcTaxYear}</RelatedTaxYear>
  <NoPaymentDates>
    <From>${hmrcTaxYear.replace('-', '-04-06').slice(0, 10)}</From>
    <To>${hmrcTaxYear.split('-')[0]}-03-05</To>
  </NoPaymentDates>
  <EmpMonthlyTotals>
    <TaxMonth>${taxMonth}</TaxMonth>
    <NIC>
      <EEsContribsYTD>${fmtMoney(totalEmpNI)}</EEsContribsYTD>
      <ERsContribsYTD>${fmtMoney(totalErpNI)}</ERsContribsYTD>
    </NIC>
  </EmpMonthlyTotals>
</EmployerPaymentSummary>`;

  return Buffer.from(xml, 'utf-8');
}

// ── Government Gateway submission ─────────────────────────────────────────────

/**
 * Wraps an RTI payload in the GovTalk SOAP envelope and submits to the
 * Government Gateway transaction engine.
 *
 * @param {Buffer|string} xmlPayload  – the raw RTI XML (FPS or EPS body)
 * @param {'fps'|'eps'} type
 * @param {object} config             – config with gatewayUserId/Password/payeRef
 * @param {string} correlationId
 * @param {object} [context]          – { clientIp, userId, serverIp } for fraud prevention headers
 * @returns {Promise<{ status: string, correlationId: string, errors: string[], rawResponse: string }>}
 */
async function submitToGateway(xmlPayload, type, config, correlationId, context = {}) {
  const txClass = type === 'fps'
    ? 'HMRC-PAYE-RTI-FPS'
    : 'HMRC-PAYE-RTI-EPS';

  const xmlBody  = Buffer.isBuffer(xmlPayload) ? xmlPayload.toString('utf-8') : String(xmlPayload);
  const userId   = config.gatewayUserId || '';
  const password = config.gatewayPassword || '';

  if (!userId || !password) {
    throw new Error('Government Gateway credentials not configured. Add them in Settings → Payroll.');
  }

  // GovTalk SOAP envelope (stripped-down IR envelope format for RTI)
  const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<GovTalkMessage xmlns="http://www.govtalk.gov.uk/CM/envelope">
  <EnvelopeVersion>2.0</EnvelopeVersion>
  <Header>
    <MessageDetails>
      <Class>${xmlEscape(txClass)}</Class>
      <Qualifier>request</Qualifier>
      <Function>submit</Function>
      <CorrelationID>${xmlEscape(correlationId)}</CorrelationID>
    </MessageDetails>
    <SenderDetails>
      <IDAuthentication>
        <SenderID>${xmlEscape(userId)}</SenderID>
        <Authentication>
          <Method>clear</Method>
          <Value>${xmlEscape(password)}</Value>
        </Authentication>
      </IDAuthentication>
    </SenderDetails>
  </Header>
  <GovTalkDetails>
    <Keys>
      <Key Type="TaxOfficeNumber">${xmlEscape((config.payeRef || '').split('/')[0])}</Key>
      <Key Type="TaxOfficeReference">${xmlEscape((config.payeRef || '').split('/').slice(1).join('/'))}</Key>
    </Keys>
  </GovTalkDetails>
  <Body>
${xmlBody}
  </Body>
</GovTalkMessage>`;

  let rawResponse = '';
  try {
    const resp = await axios.post(ggUrl(), soapEnvelope, {
      headers: {
        'Content-Type': 'application/xml; charset=UTF-8',
        'Accept':        'application/xml',
        ...buildFraudHeaders(context),
      },
      timeout: 60000,
      responseType: 'text'
    });
    rawResponse = String(resp.data || '');
  } catch (err) {
    rawResponse = String(err?.response?.data || err.message || 'Network error');
    logger.error(`[hmrcRtiService] submitToGateway: HTTP error — ${err.message}`, { stack: err.stack });
    // Return rejected status so callers can log/display it
    return { status: 'rejected', correlationId, errors: [err.message], rawResponse };
  }

  // Parse response — look for Qualifier (acknowledgement|error) and CorrelationID
  const qualMatch   = rawResponse.match(/<Qualifier[^>]*>([^<]+)<\/Qualifier>/i);
  const qualifier   = (qualMatch?.[1] || '').trim().toLowerCase();
  const corrMatch   = rawResponse.match(/<CorrelationID[^>]*>([^<]+)<\/CorrelationID>/i);
  const returnedCorr = (corrMatch?.[1] || correlationId).trim();

  // Collect any GovTalk error messages
  const errors = [];
  const errRx = /<Error[^>]*>[\s\S]*?<Number[^>]*>([^<]+)<\/Number>[\s\S]*?<Text[^>]*>([^<]+)<\/Text>[\s\S]*?<\/Error>/gi;
  let m;
  while ((m = errRx.exec(rawResponse)) !== null) {
    errors.push(`[${m[1]}] ${m[2]}`);
  }

  const status = qualifier === 'acknowledgement' ? 'accepted'
               : qualifier === 'error'           ? 'rejected'
               : errors.length > 0               ? 'rejected'
               : 'submitted';

  return { status, correlationId: returnedCorr, errors, rawResponse };
}

// ── FPS submit ────────────────────────────────────────────────────────────────

/**
 * Builds and submits a FPS for a run to HMRC, saves a PayrollSubmission record.
 *
 * @param {string} runUuid
 * @param {object} [context]  – { clientIp, userId, serverIp } for fraud prevention headers
 */
async function submitFPSForRun(runUuid, context = {}) {
  const PayrollRun        = mdb.INTERNAL?.payrollRun;
  const PayrollSubmission = mdb.INTERNAL?.payrollSubmission;
  if (!PayrollRun || !PayrollSubmission) throw new Error('Database not ready');

  const run = await PayrollRun.findOne({ uuid: runUuid }).lean();
  if (!run) throw new Error(`Run not found: ${runUuid}`);

  const xmlBuffer    = await buildFPSForRun(runUuid);
  const config       = await loadConfig();
  const correlationId = newCorrelationId();

  const xmlStr = xmlBuffer.toString('utf-8');

  // Save as 'generated' first
  const submission = await PayrollSubmission.create({
    type: 'FPS',
    taxYear:   run.taxYear,
    taxMonth:  run.taxMonth,
    taxWeek:   run.taxWeek,
    runId:     run._id,
    xmlPayload: xmlStr,
    status: 'generated',
    hmrcCorrelationId: correlationId
  });

  const result = await submitToGateway(xmlBuffer, 'fps', config, correlationId, context);

  submission.status             = result.status;
  submission.submittedAt        = new Date();
  submission.hmrcCorrelationId  = result.correlationId;
  submission.hmrcResponse       = result.rawResponse?.slice(0, 10000); // cap to avoid huge docs
  submission.errorMessages      = result.errors;
  await submission.save();

  if (result.status === 'accepted') {
    // Mark run as submitted
    await PayrollRun.updateOne({ _id: run._id }, { $set: { status: 'submitted' } });
    logger.info(`[hmrcRtiService] FPS accepted for run ${runUuid}, corr=${result.correlationId}`);
  } else {
    logger.warn(`[hmrcRtiService] FPS ${result.status} for run ${runUuid}: ${result.errors.join('; ')}`);
  }

  return result;
}

// ── EPS submit ────────────────────────────────────────────────────────────────

/**
 * Builds and submits an EPS to HMRC, saves a PayrollSubmission record.
 *
 * @param {string} taxYear
 * @param {number} taxMonth
 * @param {object} [context]  – { clientIp, userId, serverIp } for fraud prevention headers
 */
async function submitEPS(taxYear, taxMonth, context = {}) {
  const PayrollSubmission = mdb.INTERNAL?.payrollSubmission;
  if (!PayrollSubmission) throw new Error('Database not ready');

  const xmlBuffer     = await buildEPS(taxYear, taxMonth);
  const config        = await loadConfig();
  const correlationId = newCorrelationId();
  const xmlStr        = xmlBuffer.toString('utf-8');

  const submission = await PayrollSubmission.create({
    type: 'EPS',
    taxYear,
    taxMonth: Number(taxMonth),
    xmlPayload: xmlStr,
    status: 'generated',
    hmrcCorrelationId: correlationId
  });

  const result = await submitToGateway(xmlBuffer, 'eps', config, correlationId, context);

  submission.status             = result.status;
  submission.submittedAt        = new Date();
  submission.hmrcCorrelationId  = result.correlationId;
  submission.hmrcResponse       = result.rawResponse?.slice(0, 10000);
  submission.errorMessages      = result.errors;
  await submission.save();

  if (result.status === 'accepted') {
    logger.info(`[hmrcRtiService] EPS accepted for ${taxYear} M${taxMonth}, corr=${result.correlationId}`);
  } else {
    logger.warn(`[hmrcRtiService] EPS ${result.status} for ${taxYear} M${taxMonth}: ${result.errors.join('; ')}`);
  }

  return result;
}

module.exports = {
  buildFPSForRun,
  buildEPS,
  submitFPSForRun,
  submitEPS,
  buildFraudHeaders,
};
