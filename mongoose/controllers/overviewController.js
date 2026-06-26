'use strict';

const path = require('path');
const fleetService = require('../services/fleetService');
const humanOverviewService = require('../services/humanOverviewService');
const holidayOverviewService = require('../services/holidayOverviewService');
const financeOverviewService = require('../services/financeOverviewService');
const projectsOverviewService = require('../services/projectsOverviewService');
const kashflowProjectService = require('../services/kashflowProjectService');
const adminOverviewService = require('../services/adminOverviewService');
const documentsOverviewService = require('../services/documentsOverviewService');
const subcontractorsOverviewService = require('../services/subcontractorsOverviewService');
const payrollOverviewService        = require('../services/payrollOverviewService');
const policiesOverviewService       = require('../services/policiesOverviewService');

exports.getFleetOverview = async (req, res, next) => {
  try {
    const expiryDays = parseInt(req.query.days) || 30;
    const overview = await fleetService.getFleetOverview({ expiryDays });
    res.render(path.join('tailwindcss', 'overview', 'fleet'), {
      title: 'Fleet Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getHumanOverview = async (req, res, next) => {
  try {
    const contractEndDays = parseInt(req.query.days) || 60;
    const overview = await humanOverviewService.getHumanOverview({ contractEndDays });
    res.render(path.join('tailwindcss', 'overview', 'human'), {
      title: 'Human Resources',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getHolidayOverview = async (req, res, next) => {
  try {
    const overview = await holidayOverviewService.getHolidayOverview();
    res.render(path.join('tailwindcss', 'overview', 'holiday'), {
      title: 'Holiday Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getFinanceOverview = async (req, res, next) => {
  try {
    const overview = await financeOverviewService.getFinanceOverview();
    res.render(path.join('tailwindcss', 'overview', 'finance'), {
      title: 'Finance Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getProjectsOverview = async (req, res, next) => {
  try {
    const overview = await projectsOverviewService.getProjectsOverview();
    res.render(path.join('tailwindcss', 'overview', 'projects'), {
      title: 'Projects Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getAdminOverview = async (req, res, next) => {
  try {
    const overview = await adminOverviewService.getAdminOverview();
    res.render(path.join('tailwindcss', 'overview', 'admin'), {
      title: 'Admin Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getDocumentsOverview = async (req, res, next) => {
  try {
    const overview = await documentsOverviewService.getDocumentsOverview();
    res.render(path.join('tailwindcss', 'overview', 'documents'), {
      title: 'Documents Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getSubcontractorsOverview = async (req, res, next) => {
  try {
    const overview = await subcontractorsOverviewService.getSubcontractorsOverview();
    res.render(path.join('tailwindcss', 'overview', 'subcontractors'), {
      title: 'Subcontractors Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.getPayrollOverview = async (req, res, next) => {
  try {
    const overview = await payrollOverviewService.getPayrollOverview();
    const currencyService = require('../../services/currencyService');
    res.render(path.join('tailwindcss', 'overview', 'payroll'), {
      title: `Payroll Overview — ${overview.taxYear}`,
      formatCurrency: currencyService.formatCurrency,
      ...overview
    });
  } catch (err) {
    next(err);
  }
};

exports.postProjectsFinancialCheck = async (req, res, next) => {
  try {
    const notifyEmail = (req.body.notifyEmail || '').trim();
    const result = await kashflowProjectService.checkProjectFinancials({ notifyEmail });
    req.flash?.('success',
      `Financial check complete: ${result.checked} project(s) checked, ${result.atRisk} at risk${result.emailSent ? ` — alert email sent to ${notifyEmail}` : ''}.`
    );
    // The check succeeded even if the alert email did not send — surface the
    // delivery problem separately rather than failing the whole operation.
    if (result.atRisk > 0 && !result.emailSent && result.emailError) {
      req.flash?.('error', `Alert email could not be sent: ${result.emailError}`);
    }
  } catch (err) {
    req.flash?.('error', `Financial check failed: ${err.message}`);
  }
  res.redirect('/overview/projects');
};

exports.getPoliciesOverview = async (req, res, next) => {
  try {
    const overview = await policiesOverviewService.getPoliciesOverview();
    res.render(path.join('tailwindcss', 'overview', 'policies'), {
      title: 'Policies Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};

exports.postProjectMarkComplete = async (req, res, next) => {
  const projectNumber = parseInt(req.params.number, 10);
  try {
    await kashflowProjectService.markProjectComplete(projectNumber);
    req.flash?.('success', `Project ${projectNumber} marked as Completed in KashFlow.`);
  } catch (err) {
    req.flash?.('error', `Failed to mark project ${projectNumber} complete: ${err.message}`);
  }
  res.redirect('/overview/projects');
};
