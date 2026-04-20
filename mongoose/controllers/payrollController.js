'use strict';

const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const taxService = require('../../services/taxService');
const encryptionService = require('../../services/encryptionService');
const payrollCalc = require('../services/payrollCalculationService');
const payrollJournal = require('../services/payrollJournalService');
const hmrcRti = require('../../services/hmrcRtiService');
const { getClientIp } = require('../../services/ipService');
const peoplesPension = require('../../services/peoplesPensionService');

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return Number(v.toString());
  return Number(v) || 0;
}

/** Safely decrypt a field; returns null if the value is empty/null. */
function safeDecrypt(value) {
  if (!value) return null;
  try { return encryptionService.decrypt(value); } catch { return null; }
}

/** Safely encrypt a field; returns null if the value is empty. */
function safeEncrypt(value) {
  if (!value || !String(value).trim()) return null;
  return encryptionService.encrypt(String(value).trim());
}

/** Format a Decimal128 for display */
function fmt(v, dp = 2) {
  const n = toNum(v);
  return n.toFixed(dp);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

exports.renderDashboard = async (req, res, next) => {
  try {
    const PayrollRun = mdb.INTERNAL?.payrollRun;
    const currentYear = taxService.getCurrentTaxYear();
    const taxYear = `${currentYear}/${String(currentYear + 1).slice(-2)}`;

    const recentRuns = await PayrollRun.find({ taxYear })
      .sort({ paymentDate: -1 })
      .limit(10)
      .lean();

    // Aggregate totals for this tax year
    const allRuns = await PayrollRun.find({ taxYear }).lean();
    const yearTotals = allRuns.reduce((acc, run) => {
      acc.grossPay       += toNum(run.totals?.grossPay);
      acc.taxDeducted    += toNum(run.totals?.taxDeducted);
      acc.employeeNI     += toNum(run.totals?.employeeNI);
      acc.employerNI     += toNum(run.totals?.employerNI);
      acc.employeePension += toNum(run.totals?.employeePension);
      acc.employerPension += toNum(run.totals?.employerPension);
      acc.netPay         += toNum(run.totals?.netPay);
      return acc;
    }, { grossPay: 0, taxDeducted: 0, employeeNI: 0, employerNI: 0, employeePension: 0, employerPension: 0, netPay: 0 });

    // Next submission deadlines
    const now = new Date();
    const currentTaxMonth = taxService.calculateTaxYearAndMonth(now).taxMonth;
    const nextDeadline = taxService.getCurrentMonthlyReturn(currentYear, currentTaxMonth);

    res.render(path.join('tailwindcss', 'payroll', 'dashboard'), {
      title: `Payroll Dashboard — ${taxYear}`,
      taxYear,
      recentRuns,
      yearTotals,
      nextDeadline,
      fmt,
      toNum
    });
  } catch (err) {
    next(err);
  }
};

// ── Run list ──────────────────────────────────────────────────────────────────

exports.renderRunList = async (req, res, next) => {
  try {
    const PayrollRun = mdb.INTERNAL?.payrollRun;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.taxYear) filter.taxYear = req.query.taxYear;
    if (req.query.frequency) filter.frequency = req.query.frequency;
    if (req.query.status) filter.status = req.query.status;

    const [runs, total] = await Promise.all([
      PayrollRun.find(filter).sort({ paymentDate: -1 }).skip(skip).limit(limit).lean(),
      PayrollRun.countDocuments(filter)
    ]);

    res.render(path.join('tailwindcss', 'payroll', 'runs'), {
      title: 'Payroll Runs',
      runs,
      total,
      page,
      pages: Math.ceil(total / limit),
      query: req.query,
      fmt,
      toNum
    });
  } catch (err) {
    next(err);
  }
};

// ── Create run ────────────────────────────────────────────────────────────────

exports.createRun = async (req, res, next) => {
  try {
    const PayrollRun = mdb.INTERNAL?.payrollRun;
    const { frequency, periodStart, periodEnd, paymentDate, taxYear, taxMonth, taxWeek } = req.body;

    if (!frequency || !periodStart || !periodEnd || !paymentDate || !taxYear) {
      req.flash?.('error', 'All fields are required to create a payroll run.');
      return res.redirect('/payroll/runs');
    }

    // Check for overlapping run
    const existing = await PayrollRun.findOne({
      frequency,
      taxYear,
      ...(taxMonth ? { taxMonth: Number(taxMonth) } : {}),
      ...(taxWeek  ? { taxWeek:  Number(taxWeek)  } : {})
    });
    if (existing) {
      req.flash?.('error', `A ${frequency} payroll run for this period already exists.`);
      return res.redirect('/payroll/runs');
    }

    const run = await PayrollRun.create({
      frequency,
      periodStart: new Date(periodStart),
      periodEnd:   new Date(periodEnd),
      paymentDate: new Date(paymentDate),
      taxYear,
      taxMonth: taxMonth ? Number(taxMonth) : undefined,
      taxWeek:  taxWeek  ? Number(taxWeek)  : undefined,
      status: 'draft'
    });

    logger.info(`payrollController: created run ${run.uuid} (${frequency} ${taxYear})`);
    res.redirect(`/payroll/run/${run.uuid}`);
  } catch (err) {
    next(err);
  }
};

// ── Run detail ────────────────────────────────────────────────────────────────

exports.renderRunDetail = async (req, res, next) => {
  try {
    const PayrollRun   = mdb.INTERNAL?.payrollRun;
    const PayrollEntry = mdb.INTERNAL?.payrollEntry;

    const run = await PayrollRun.findOne({ uuid: req.params.uuid }).lean();
    if (!run) return res.status(404).render(path.join('tailwindcss', 'error'), { title: 'Not Found', message: 'Payroll run not found', statusCode: 404 });

    const entries = await PayrollEntry.find({ runId: run._id })
      .populate('employeeId', 'name uuid payroll')
      .sort({ 'employeeId.name': 1 })
      .lean();

    // Load any HMRC submissions for this run
    const PayrollSubmission = mdb.INTERNAL?.payrollSubmission;
    const submissions = await PayrollSubmission.find({ runId: run._id }).sort({ createdAt: -1 }).lean();

    res.render(path.join('tailwindcss', 'payroll', 'run'), {
      title: `Payroll Run — ${run.taxYear} ${run.frequency}`,
      run,
      entries,
      submissions,
      fmt,
      toNum
    });
  } catch (err) {
    next(err);
  }
};

// ── Calculate ─────────────────────────────────────────────────────────────────

exports.calculateRun = async (req, res, next) => {
  try {
    await payrollCalc.processPayrollRun(req.params.uuid);
    req.flash?.('success', 'Payroll run calculated successfully.');
    res.redirect(`/payroll/run/${req.params.uuid}`);
  } catch (err) {
    logger.error(`payrollController.calculateRun: ${err.message}`);
    next(err);
  }
};

// ── Override entry ────────────────────────────────────────────────────────────

exports.overrideEntry = async (req, res, next) => {
  try {
    const PayrollEntry = mdb.INTERNAL?.payrollEntry;
    const PayrollRun   = mdb.INTERNAL?.payrollRun;

    const run = await PayrollRun.findOne({ uuid: req.params.uuid }).lean();
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'submitted') return res.status(400).json({ error: 'Cannot edit a submitted run' });

    const entry = await PayrollEntry.findOne({ uuid: req.params.entryUuid, runId: run._id });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const allowedFields = [
      'grossPayManualAdjustment', 'taxDeducted', 'employeeNI', 'employerNI',
      'employeePension', 'employerPension', 'netPay', 'studentLoanDeduction', 'postgradLoanDeduction', 'notes'
    ];

    const updates = {};
    const overrideFlags = [...(entry.overrideFlags || [])];

    for (const [field, value] of Object.entries(req.body)) {
      if (!allowedFields.includes(field)) continue;
      updates[field] = value;
      if (!overrideFlags.includes(field)) overrideFlags.push(field);
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    updates.overrideFlags = overrideFlags;
    await PayrollEntry.updateOne({ _id: entry._id }, { $set: updates });

    logger.info(`payrollController: override entry ${entry.uuid} fields: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true, overrideFlags });
  } catch (err) {
    next(err);
  }
};

// ── Lock / unlock ─────────────────────────────────────────────────────────────

exports.lockRun = async (req, res, next) => {
  try {
    const PayrollRun   = mdb.INTERNAL?.payrollRun;
    const PayrollEntry = mdb.INTERNAL?.payrollEntry;

    const run = await PayrollRun.findOne({ uuid: req.params.uuid });
    if (!run) return res.status(404).send('Run not found');
    if (run.status === 'submitted') { req.flash?.('error', 'Cannot lock a submitted run.'); return res.redirect(`/payroll/run/${run.uuid}`); }

    const entryCount = await PayrollEntry.countDocuments({ runId: run._id });
    if (entryCount === 0) { req.flash?.('error', 'Cannot lock a run with no entries. Calculate first.'); return res.redirect(`/payroll/run/${run.uuid}`); }

    run.status = 'locked';
    await run.save();
    logger.info(`payrollController: locked run ${run.uuid}`);
    req.flash?.('success', 'Payroll run locked.');
    res.redirect(`/payroll/run/${run.uuid}`);
  } catch (err) { next(err); }
};

exports.unlockRun = async (req, res, next) => {
  try {
    const PayrollRun = mdb.INTERNAL?.payrollRun;
    const run = await PayrollRun.findOne({ uuid: req.params.uuid });
    if (!run) return res.status(404).send('Run not found');
    if (run.status === 'submitted') { req.flash?.('error', 'Cannot unlock a submitted run.'); return res.redirect(`/payroll/run/${run.uuid}`); }

    run.status = 'draft';
    await run.save();
    logger.info(`payrollController: unlocked run ${run.uuid}`);
    req.flash?.('success', 'Payroll run unlocked.');
    res.redirect(`/payroll/run/${run.uuid}`);
  } catch (err) { next(err); }
};

// ── KashFlow journal ──────────────────────────────────────────────────────────

exports.postJournal = async (req, res, next) => {
  try {
    await payrollJournal.postPayrollJournal(req.params.uuid);
    req.flash?.('success', 'Payroll journal posted to KashFlow.');
    res.redirect(`/payroll/run/${req.params.uuid}`);
  } catch (err) {
    logger.error(`payrollController.postJournal: ${err.message}`);
    req.flash?.('error', `Journal posting failed: ${err.message}`);
    res.redirect(`/payroll/run/${req.params.uuid}`);
  }
};

// ── HMRC RTI — FPS ────────────────────────────────────────────────────────────

exports.downloadFPS = async (req, res, next) => {
  try {
    const xmlBuffer = await hmrcRti.buildFPSForRun(req.params.uuid);
    const filename = `FPS_${req.params.uuid}.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xmlBuffer);
  } catch (err) {
    logger.error(`payrollController.downloadFPS: ${err.message}`);
    next(err);
  }
};

exports.submitFPS = async (req, res, next) => {
  try {
    const context = { clientIp: getClientIp(req), userId: req.user?.username || req.user?.email || 'unknown' };
    const result = await hmrcRti.submitFPSForRun(req.params.uuid, context);
    if (result.status === 'accepted') {
      req.flash?.('success', `FPS accepted by HMRC. Correlation ID: ${result.correlationId}`);
    } else {
      req.flash?.('error', `FPS rejected by HMRC: ${(result.errors || []).join('; ')}`);
    }
    res.redirect(`/payroll/run/${req.params.uuid}`);
  } catch (err) {
    logger.error(`payrollController.submitFPS: ${err.message}`);
    req.flash?.('error', `FPS submission failed: ${err.message}`);
    res.redirect(`/payroll/run/${req.params.uuid}`);
  }
};

// ── HMRC RTI — EPS ────────────────────────────────────────────────────────────

exports.downloadEPS = async (req, res, next) => {
  try {
    const xmlBuffer = await hmrcRti.buildEPS(req.params.year, parseInt(req.params.month));
    const filename = `EPS_${req.params.year}_M${req.params.month}.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xmlBuffer);
  } catch (err) { next(err); }
};

exports.submitEPS = async (req, res, next) => {
  try {
    const context = { clientIp: getClientIp(req), userId: req.user?.username || req.user?.email || 'unknown' };
    const result = await hmrcRti.submitEPS(req.params.year, parseInt(req.params.month), context);
    if (result.status === 'accepted') {
      req.flash?.('success', `EPS accepted by HMRC. Correlation ID: ${result.correlationId}`);
    } else {
      req.flash?.('error', `EPS rejected by HMRC: ${(result.errors || []).join('; ')}`);
    }
    res.redirect('/payroll/submissions');
  } catch (err) { next(err); }
};

// ── Submissions list ──────────────────────────────────────────────────────────

exports.renderSubmissions = async (req, res, next) => {
  try {
    const PayrollSubmission = mdb.INTERNAL?.payrollSubmission;
    const submissions = await PayrollSubmission.find({})
      .populate('runId', 'uuid taxYear frequency paymentDate')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    res.render(path.join('tailwindcss', 'payroll', 'submissions'), {
      title: 'HMRC Submissions',
      submissions
    });
  } catch (err) { next(err); }
};

// ── People's Pension ──────────────────────────────────────────────────────────

exports.downloadPensionCSV = async (req, res, next) => {
  try {
    const PayrollRun   = mdb.INTERNAL?.payrollRun;
    const PayrollEntry = mdb.INTERNAL?.payrollEntry;

    const run = await PayrollRun.findOne({ uuid: req.params.uuid }).lean();
    if (!run) return res.status(404).send('Run not found');

    const entries = await PayrollEntry.find({ runId: run._id })
      .populate('employeeId')
      .lean();

    const csvBuffer = await peoplesPension.generateContributionsCSV(run, entries);
    const filename = `PensionContributions_${run.uuid}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvBuffer);
  } catch (err) { next(err); }
};

exports.submitPension = async (req, res, next) => {
  try {
    const PayrollRun   = mdb.INTERNAL?.payrollRun;
    const PayrollEntry = mdb.INTERNAL?.payrollEntry;
    const run = await PayrollRun.findOne({ uuid: req.params.uuid }).lean();
    if (!run) return res.status(404).send('Run not found');
    const entries = await PayrollEntry.find({ runId: run._id }).populate('employeeId').lean();
    await peoplesPension.submitViaAPI(run, entries);
    req.flash?.('success', 'Pension contributions submitted.');
    res.redirect(`/payroll/run/${run.uuid}`);
  } catch (err) {
    req.flash?.('error', `Pension submission failed: ${err.message}`);
    res.redirect(`/payroll/run/${req.params.uuid}`);
  }
};

// ── Payroll settings ──────────────────────────────────────────────────────────

exports.renderPayrollSettings = async (req, res, next) => {
  try {
    const PayrollConfig = mdb.INTERNAL?.payrollConfig;
    const raw = await PayrollConfig.findOne().lean();

    // Decrypt sensitive fields for display (masked)
    const config = raw ? {
      ...raw,
      payeSchemeReference: safeDecrypt(raw.payeSchemeReference),
      accountsOfficeRef:   safeDecrypt(raw.accountsOfficeRef),
      pensionEmployerRef:  safeDecrypt(raw.pensionEmployerRef),
      gatewayUserId:     raw.gatewayUserId  ? '••••••••' : null,
      gatewayPassword:   raw.gatewayPassword ? '••••••••' : null
    } : null;

    res.render(path.join('tailwindcss', 'payroll', 'settings'), {
      title: 'Payroll Settings',
      config,
      fmt
    });
  } catch (err) { next(err); }
};

exports.savePayrollSettings = async (req, res, next) => {
  try {
    const PayrollConfig = mdb.INTERNAL?.payrollConfig;
    const {
      payeSchemeReference, accountsOfficeRef, employerName, contactName, contactPhone, contactEmail,
      defaultEmployeePensionRate, defaultEmployerPensionRate, pensionProviderName, pensionEmployerRef,
      grossWages, employerNI, employerPension, payeNiControl, netPayControl, pensionControl, bankNominal,
      gatewayUserId, gatewayPassword
    } = req.body;

    const existing = await PayrollConfig.findOne().lean();

    const updates = {
      employerName: employerName || null,
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      contactEmail: contactEmail || null,
      defaultEmployeePensionRate: defaultEmployeePensionRate ? parseFloat(defaultEmployeePensionRate) : 5.0,
      defaultEmployerPensionRate: defaultEmployerPensionRate ? parseFloat(defaultEmployerPensionRate) : 3.0,
      pensionProviderName: pensionProviderName || "People's Pension",
      kashflowNominals: {
        grossWages:     grossWages     ? parseInt(grossWages)     : null,
        employerNI:     employerNI     ? parseInt(employerNI)     : null,
        employerPension: employerPension ? parseInt(employerPension) : null,
        payeNiControl:  payeNiControl  ? parseInt(payeNiControl)  : null,
        netPayControl:  netPayControl  ? parseInt(netPayControl)  : null,
        pensionControl: pensionControl ? parseInt(pensionControl) : null,
        bankNominal:    bankNominal    ? parseInt(bankNominal)    : null
      }
    };

    // Only encrypt if new value provided (not the masked '••••••••')
    if (payeSchemeReference && payeSchemeReference !== '••••••••') {
      updates.payeSchemeReference = safeEncrypt(payeSchemeReference);
    }
    if (accountsOfficeRef && accountsOfficeRef !== '••••••••') {
      updates.accountsOfficeRef = safeEncrypt(accountsOfficeRef);
    }
    if (pensionEmployerRef && pensionEmployerRef !== '••••••••') {
      updates.pensionEmployerRef = safeEncrypt(pensionEmployerRef);
    }
    if (gatewayUserId && gatewayUserId !== '••••••••') {
      updates.gatewayUserId = safeEncrypt(gatewayUserId);
    }
    if (gatewayPassword && gatewayPassword !== '••••••••') {
      updates.gatewayPassword = safeEncrypt(gatewayPassword);
    }

    await PayrollConfig.findOneAndUpdate({}, { $set: updates }, { upsert: true, setDefaultsOnInsert: true });
    req.flash?.('success', 'Payroll settings saved.');
    res.redirect('/settings/payroll');
  } catch (err) { next(err); }
};

// ── Tax rates management ──────────────────────────────────────────────────────

exports.renderTaxRates = async (req, res, next) => {
  try {
    const PayrollTaxRates = mdb.INTERNAL?.payrollTaxRates;
    const rates = await PayrollTaxRates.find({}).sort({ taxYear: -1 }).lean();
    res.render(path.join('tailwindcss', 'payroll', 'taxRates'), {
      title: 'Payroll Tax Rates',
      rates
    });
  } catch (err) { next(err); }
};

exports.renderEditTaxRate = async (req, res, next) => {
  try {
    const PayrollTaxRates = mdb.INTERNAL?.payrollTaxRates;
    const isNew = req.params.year === 'new';
    const rate = isNew
      ? { taxYear: '' }
      : await PayrollTaxRates.findOne({ taxYear: decodeURIComponent(req.params.year) }).lean();

    if (!rate && !isNew) return res.status(404).send('Tax rates not found for this year');

    res.render(path.join('tailwindcss', 'payroll', 'editTaxRate'), {
      title: isNew ? 'Add Tax Rates' : `Edit Tax Rates — ${rate.taxYear}`,
      rate,
      isNew
    });
  } catch (err) { next(err); }
};

exports.saveEditTaxRate = async (req, res, next) => {
  try {
    const PayrollTaxRates = mdb.INTERNAL?.payrollTaxRates;
    const isNew = req.params.year === 'new';

    const fields = [
      'taxYear', 'personalAllowance', 'basicRateLimit', 'higherRateThreshold', 'additionalRateThreshold',
      'basicRate', 'higherRate', 'additionalRate',
      'niLEL', 'niPT', 'niUEL', 'niEmployeeMain', 'niEmployeeUpper',
      'niST', 'niEmployerRate', 'aeQualifyingLower', 'aeQualifyingUpper',
      'studentLoanPlan1Threshold', 'studentLoanPlan2Threshold', 'studentLoanPlan4Threshold',
      'studentLoanPostgradThreshold', 'studentLoanRate', 'postgradLoanRate'
    ];

    const data = {};
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        data[f] = f === 'taxYear' ? req.body[f] : parseFloat(req.body[f]);
      }
    }

    if (isNew) {
      await PayrollTaxRates.create(data);
    } else {
      await PayrollTaxRates.findOneAndUpdate({ taxYear: decodeURIComponent(req.params.year) }, { $set: data }, { upsert: false });
    }

    req.flash?.('success', `Tax rates for ${data.taxYear} saved.`);
    res.redirect('/settings/payroll/tax-rates');
  } catch (err) { next(err); }
};

// ── Employee payroll settings ─────────────────────────────────────────────────

exports.renderEmployeePayroll = async (req, res, next) => {
  try {
    const Employee = mdb.INTERNAL?.employee;
    const employee = await Employee.findOne({ uuid: req.params.uuid }).lean();
    if (!employee) return res.status(404).render(path.join('tailwindcss', 'error'), { title: '404', error: { title: '404', message: 'Employee not found.' } });

    // Decrypt NI number for display (masked to last 2 chars)
    let niDisplay = '';
    if (employee.payroll?.niNumber) {
      try {
        const plain = encryptionService.decrypt(employee.payroll.niNumber);
        niDisplay = plain ? `••••••${plain.slice(-2)}` : '';
      } catch { niDisplay = ''; }
    }

    res.render(path.join('tailwindcss', 'payroll', 'employeePayroll'), {
      title: `Payroll Settings — ${employee.name || employee.firstName || 'Employee'}`,
      employee,
      niDisplay,
      csrfToken: res.locals.csrfToken
    });
  } catch (err) { next(err); }
};

exports.saveEmployeePayroll = async (req, res, next) => {
  try {
    const Employee = mdb.INTERNAL?.employee;
    const employee = await Employee.findOne({ uuid: req.params.uuid });
    if (!employee) return res.status(404).render(path.join('tailwindcss', 'error'), { title: '404', error: { title: '404', message: 'Employee not found.' } });

    const {
      niNumber, niCategory, taxCode, taxBasis, payeStartDate, payrollId, starterDeclaration,
      ytdGrossPay, ytdTaxPaid, ytdEmployeeNI, ytdEmployerNI,
      studentLoanPlan, postgradLoan, pensionEnrolled, pensionOptOutDate,
      employeePensionRate, employerPensionRate, salarySacrifice
    } = req.body;

    const payroll = {
      niCategory:          niCategory || 'A',
      taxCode:             taxCode || '1257L',
      taxBasis:            taxBasis || 'cumulative',
      payeStartDate:       payeStartDate ? new Date(payeStartDate) : null,
      payrollId:           payrollId || null,
      starterDeclaration:  starterDeclaration || null,
      ytdGrossPay:         parseFloat(ytdGrossPay)  || 0,
      ytdTaxPaid:          parseFloat(ytdTaxPaid)   || 0,
      ytdEmployeeNI:       parseFloat(ytdEmployeeNI) || 0,
      ytdEmployerNI:       parseFloat(ytdEmployerNI) || 0,
      studentLoanPlan:     studentLoanPlan || 'none',
      postgradLoan:        postgradLoan === 'on' || postgradLoan === 'true',
      pensionEnrolled:     pensionEnrolled === 'on' || pensionEnrolled === 'true',
      pensionOptOutDate:   pensionOptOutDate ? new Date(pensionOptOutDate) : null,
      employeePensionRate: employeePensionRate ? parseFloat(employeePensionRate) : null,
      employerPensionRate: employerPensionRate ? parseFloat(employerPensionRate) : null,
      salarySacrifice:     salarySacrifice === 'on' || salarySacrifice === 'true'
    };

    // Encrypt NI number only if a new value was supplied (not the masked placeholder)
    if (niNumber && niNumber !== '' && !niNumber.startsWith('••')) {
      payroll.niNumber = safeEncrypt(niNumber.toUpperCase().replace(/\s/g, ''));
    } else {
      payroll.niNumber = employee.payroll?.niNumber ?? null;
    }

    employee.set({ payroll });
    await employee.save();

    req.flash?.('success', 'Employee payroll settings saved.');
    res.redirect(`/payroll/employee/${req.params.uuid}`);
  } catch (err) { next(err); }
};
