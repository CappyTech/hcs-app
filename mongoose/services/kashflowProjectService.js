'use strict';

const logger = require('../../services/loggerService');
const emailService = require('../../services/emailService');
const kfSession = require('../../services/kashflowSessionService');
const axios = kfSession.kfAxios;
const mdb = require('./mongooseDatabaseService');
const hcsSyncService = require('./hcsSyncService');

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
    atRisk: incomeActual > 0 && incomeDiff < 0,
  };
}

// ── Financial check (email alerts) ──────────────────────────────────────────

/**
 * Reads all active KashFlow projects from the REST namespace, computes
 * financial health, and sends an alert email for any project where the income
 * difference is negative (actual < target).
 *
 * @param {object} [opts]
 * @param {string} [opts.notifyEmail] - Address to send alert to (required to send email)
 * Returns { checked, atRisk, emailSent }
 */
async function checkProjectFinancials({ notifyEmail } = {}) {
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
    const to = notifyEmail ||
      process.env.NOTIFY_EMAIL ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER;

    if (to) {
      const fmt = n => `£${Number(n).toFixed(2)}`;
      const baseUrl = process.env.BASE_URL || '';
      const kfBase = 'https://app.kashflow.com/editProject.asp';

      const rows = atRisk
        .map(p => {
          const kfLink = p.Id
            ? `<a href="${kfBase}?id=${p.Id}" style="color:#4f46e5;text-decoration:none">${p.Number} — ${p.Name || '—'}</a>`
            : `${p.Number} — ${p.Name || '—'}`;
          return `
          <tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${kfLink}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280">${p.CustomerName || '—'}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${fmt(p._financials.incomeTarget)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${fmt(p._financials.incomeActual)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:#dc2626;font-weight:600">${fmt(p._financials.incomeDiff)}</td>
          </tr>`;
        })
        .join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;font-family:Arial,sans-serif;font-size:14px;color:#111827">
  <p style="margin:0 0 16px"><strong>${atRisk.length} KashFlow project${atRisk.length !== 1 ? 's are' : ' is'} below income target.</strong></p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
    <thead>
      <tr style="background:#f1f5f9">
        <th style="padding:7px 10px;text-align:left;border:1px solid #e5e7eb">Project</th>
        <th style="padding:7px 10px;text-align:left;border:1px solid #e5e7eb">Customer</th>
        <th style="padding:7px 10px;text-align:right;border:1px solid #e5e7eb">Target</th>
        <th style="padding:7px 10px;text-align:right;border:1px solid #e5e7eb">Actual</th>
        <th style="padding:7px 10px;text-align:right;border:1px solid #e5e7eb">Shortfall</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin:16px 0 0;font-size:13px;color:#6b7280">
    <a href="${baseUrl}/overview/projects" style="color:#4f46e5">View overview &rarr;</a>
  </p>
</body>
</html>`;

      const text = atRisk
        .map(
          p =>
            `${p.Number} — ${p.Name || '—'} (${p.CustomerName || '—'}): target ${fmt(p._financials.incomeTarget)}, actual ${fmt(p._financials.incomeActual)}, shortfall ${fmt(p._financials.incomeDiff)}`,
        )
        .join('\n');

      await emailService.sendMail({
        to,
        subject: `⚠ ${atRisk.length} KashFlow project(s) below income target`,
        html,
        text,
      });
      emailSent = true;
    } else {
      logger.warn('[kashflowProjectService] No notify email set — skipping alert email');
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
 * Fetches the existing project first so the PUT body contains all required fields.
 */
async function markProjectComplete(projectNumber) {
  if (!projectNumber) throw new Error('projectNumber is required');

  await kfSession.withKfAuth(async (token) => {
    const headers = { Authorization: `KfToken ${token}` };

    // Fetch the current project so we can send a complete PUT body
    const { data: existing } = await axios.get(
      `${KF_BASE}/projects/${projectNumber}`,
      { headers },
    );

    // Only send the fields the PUT endpoint accepts
    const body = {
      Number:                existing.Number,
      Name:                  existing.Name,
      Reference:             existing.Reference,
      Description:           existing.Description,
      Note:                  existing.Note,
      Status:                'Completed',
      StartDate:             existing.StartDate,
      EndDate:               existing.EndDate,
      CustomerCode:          existing.CustomerCode,
      TargetSalesAmount:     existing.TargetSalesAmount,
      TargetPurchasesAmount: existing.TargetPurchasesAmount,
      ExcludeVAT:            existing.ExcludeVAT,
    };

    await axios.put(
      `${KF_BASE}/projects/${projectNumber}`,
      body,
      { headers },
    );
  });

  logger.info(`[kashflowProjectService] Marked project ${projectNumber} as Completed in KashFlow`);

  // The KashFlow write succeeded, but the local REST-namespace copy (maintained
  // by hcs-sync) is now stale — it still shows the project as active. Re-pull it
  // from KashFlow via hcs-sync so the projects overview reflects the change.
  await refreshLocalProject(projectNumber);
}

/**
 * Refresh a single project's local REST-namespace copy after a write to
 * KashFlow. Primary path: ask hcs-sync to re-pull it (authoritative, full
 * document). Fallback: if hcs-sync is unreachable, patch the local Status
 * directly so the overview stays consistent.
 */
async function refreshLocalProject(projectNumber) {
  try {
    await hcsSyncService.pullEntity('project', projectNumber);
    logger.info(`[kashflowProjectService] Re-synced project ${projectNumber} via hcs-sync`);
    return;
  } catch (err) {
    logger.warn(
      `[kashflowProjectService] hcs-sync re-pull failed for project ${projectNumber}: ${err.message} — falling back to local Status patch`,
    );
  }

  // Fallback: keep the local copy consistent even if hcs-sync is down.
  try {
    const RestProject = mdb.REST?.project;
    if (RestProject) {
      await RestProject.updateOne(
        { Number: projectNumber },
        { $set: { Status: 'Completed' } },
      );
      logger.info(`[kashflowProjectService] Patched local project ${projectNumber} Status=Completed (fallback)`);
    }
  } catch (patchErr) {
    logger.error(
      `[kashflowProjectService] Fallback local patch failed for project ${projectNumber}: ${patchErr.message}`,
    );
  }
}

module.exports = { checkProjectFinancials, markProjectComplete, computeFinancials };
