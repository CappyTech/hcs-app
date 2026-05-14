'use strict';

const axios = require('axios');
const logger = require('../../services/loggerService');
const emailService = require('../../services/emailService');
const kfSession = require('../../services/kashflowSessionService');
const mdb = require('./mongooseDatabaseService');

const KF_BASE = (
  process.env.KASHFLOW_API_BASE_URL || 'https://api.kashflow.com/v2'
).replace(/\/+$/, '');

// ── Financial helpers ────────────────────────────────────────────────────────

/**
 * Computes income/expenditure financials for a REST project document.
 * Returns { incomeTarget, incomeActual, incomeDiff, expTarget, expActual, expDiff, atRisk }
 */
function computeFinancials(project) {
  const incomeTarget = project.TargetSalesAmount ?? 0;
  const incomeActual = project.ActualSalesAmount ?? 0;
  const incomeDiff   = incomeActual - incomeTarget;

  const expTarget = project.TargetPurchasesAmount ?? 0;
  const expActual = project.ActualPurchasesAmount ?? 0;
  const expDiff   = expActual - expTarget;

  return {
    incomeTarget,
    incomeActual,
    incomeDiff,
    expTarget,
    expActual,
    expDiff,
    atRisk: incomeDiff < 0,
  };
}

// ── Financial check (email alerts) ──────────────────────────────────────────

/**
 * Reads all active KashFlow projects from the REST namespace, computes
 * financial health, and sends an alert email for any project where the income
 * difference is negative (actual < target).
 *
 * Returns { checked, atRisk, emailSent }
 */
async function checkProjectFinancials() {
  const RestProject = mdb.REST?.project;
  if (!RestProject) throw new Error('REST project model not available');

  const projects = await RestProject.find({
    Status: { $in: ['Active', 'active', 1, '1'] },
  }).lean();

  // KashFlow stores Status as a string (e.g. 'Active') or numeric 1
  // Broaden: exclude only Completed/Archived
  const activeProjects = projects.length
    ? projects
    : await RestProject.find({
        $nor: [
          { Status: 'Completed' },
          { Status: 'Archived' },
          { StatusName: 'Completed' },
        ],
      }).lean();

  const withFinancials = activeProjects.map(p => ({
    ...p,
    _financials: computeFinancials(p),
  }));

  const atRisk = withFinancials.filter(p => p._financials.atRisk);

  let emailSent = false;
  if (atRisk.length > 0) {
    const notifyEmail =
      process.env.NOTIFY_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER;

    if (notifyEmail) {
      const fmt = n => `£${Number(n).toFixed(2)}`;
      const rows = atRisk
        .map(
          p => `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #eee">${p.Number} — ${p.Name || '—'}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(p._financials.incomeTarget)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${fmt(p._financials.incomeActual)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#dc2626">${fmt(p._financials.incomeDiff)}</td>
          </tr>`,
        )
        .join('');

      const html = `
        <h2 style="font-family:sans-serif">KashFlow Projects — Income Alert</h2>
        <p style="font-family:sans-serif">
          The following ${atRisk.length} active project(s) have actual income below their target:
        </p>
        <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;width:100%">
          <thead>
            <tr style="background:#f3f4f6">
              <th style="padding:6px 10px;text-align:left">Project</th>
              <th style="padding:6px 10px;text-align:right">Target</th>
              <th style="padding:6px 10px;text-align:right">Actual</th>
              <th style="padding:6px 10px;text-align:right">Difference</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-family:sans-serif;margin-top:16px">
          Review at <a href="${process.env.BASE_URL || ''}/overview/projects">/overview/projects</a>
        </p>`;

      const text = atRisk
        .map(
          p =>
            `${p.Number} — ${p.Name || '—'}: target £${p._financials.incomeTarget.toFixed(2)}, actual £${p._financials.incomeActual.toFixed(2)}, diff £${p._financials.incomeDiff.toFixed(2)}`,
        )
        .join('\n');

      await emailService.sendMail({
        to: notifyEmail,
        subject: `⚠ ${atRisk.length} KashFlow project(s) below income target`,
        html,
        text,
      });
      emailSent = true;
    } else {
      logger.warn('[kashflowProjectService] NOTIFY_EMAIL not set — skipping alert email');
    }
  }

  logger.info(
    `[kashflowProjectService] Financial check complete: ${activeProjects.length} checked, ${atRisk.length} at risk, email sent: ${emailSent}`,
  );

  return { checked: activeProjects.length, atRisk: atRisk.length, emailSent, projects: withFinancials };
}

// ── Mark project complete via KashFlow API ───────────────────────────────────

/**
 * Sends PUT /projects/{number} to KashFlow with Status = "Completed".
 * Also updates the local MongoDB REST record so the UI reflects immediately.
 */
async function markProjectComplete(projectNumber) {
  if (!projectNumber) throw new Error('projectNumber is required');

  await kfSession.withKfAuth(async (token) => {
    await axios.put(
      `${KF_BASE}/projects/${projectNumber}`,
      { Status: 'Completed' },
      { headers: { Authorization: `KfToken ${token}` } },
    );
  });

  // Mirror in local REST namespace so next page load reflects immediately
  const RestProject = mdb.REST?.project;
  if (RestProject) {
    await RestProject.updateOne({ Number: projectNumber }, { $set: { Status: 'Completed' } });
  }

  logger.info(`[kashflowProjectService] Marked project ${projectNumber} as Completed`);
}

module.exports = { checkProjectFinancials, markProjectComplete, computeFinancials };
