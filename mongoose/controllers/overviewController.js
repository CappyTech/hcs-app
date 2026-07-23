import path from 'path';
import fleetService from '../services/fleetService.js';
import humanOverviewService from '../services/humanOverviewService.js';
import holidayOverviewService from '../services/holidayOverviewService.js';
import financeOverviewService from '../services/financeOverviewService.js';
import projectsOverviewService from '../services/projectsOverviewService.js';
import kashflowProjectService from '../services/kashflowProjectService.js';
import adminOverviewService from '../services/adminOverviewService.js';
import documentsOverviewService from '../services/documentsOverviewService.js';
import subcontractorsOverviewService from '../services/subcontractorsOverviewService.js';
import payrollOverviewService from '../services/payrollOverviewService.js';
import policiesOverviewService from '../services/policiesOverviewService.js';
import currencyService from '../../services/currencyService.js';

export const getFleetOverview = async (req, res, next) => {
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

export const getHumanOverview = async (req, res, next) => {
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

export const getHolidayOverview = async (req, res, next) => {
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

export const getFinanceOverview = async (req, res, next) => {
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

export const getProjectsOverview = async (req, res, next) => {
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

export const getAdminOverview = async (req, res, next) => {
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

export const getDocumentsOverview = async (req, res, next) => {
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

export const getSubcontractorsOverview = async (req, res, next) => {
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

export const getPayrollOverview = async (req, res, next) => {
  try {
    const overview = await payrollOverviewService.getPayrollOverview();
    res.render(path.join('tailwindcss', 'overview', 'payroll'), {
      title: `Payroll Overview — ${overview.taxYear}`,
      formatCurrency: currencyService.formatCurrency,
      ...overview
    });
  } catch (err) {
    next(err);
  }
};

export const postProjectsFinancialCheck = async (req, res, next) => {
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

export const getPoliciesOverview = async (req, res, next) => {
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

export const postProjectMarkComplete = async (req, res, next) => {
  const projectNumber = parseInt(req.params.number, 10);
  try {
    await kashflowProjectService.markProjectComplete(projectNumber);
    req.flash?.('success', `Project ${projectNumber} marked as Completed in KashFlow.`);
  } catch (err) {
    req.flash?.('error', `Failed to mark project ${projectNumber} complete: ${err.message}`);
  }
  res.redirect('/overview/projects');
};

export default { getFleetOverview, getHumanOverview, getHolidayOverview, getFinanceOverview, getProjectsOverview, getAdminOverview, getDocumentsOverview, getSubcontractorsOverview, getPayrollOverview, postProjectsFinancialCheck, getPoliciesOverview, postProjectMarkComplete };
