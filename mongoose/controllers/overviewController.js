import path from 'path';
import overviewEngine from '../services/overviewEngine.js';
import kashflowProjectService from '../services/kashflowProjectService.js';
import documentsOverviewService from '../services/documentsOverviewService.js';
import currencyService from '../../services/currencyService.js';

export const getGeneratedArea = (areaId) => async (req, res, next) => {
  try {
    const page = await overviewEngine.buildArea(req, areaId);
    if (!page) return next();
    res.render(path.join('tailwindcss', 'overview', 'generated'), { title: page.title, page });
  } catch (err) {
    next(err);
  }
};

export const getGeneratedNode = (nodeId) => async (req, res, next) => {
  try {
    const page = await overviewEngine.buildNodeOverview(req, nodeId);
    if (!page) return next();
    res.render(path.join('tailwindcss', 'overview', 'generated'), { title: page.title, page });
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
  res.redirect('/overview/project');
};

export const postProjectMarkComplete = async (req, res, next) => {
  const projectNumber = parseInt(req.params.number, 10);
  try {
    await kashflowProjectService.markProjectComplete(projectNumber);
    req.flash?.('success', `Project ${projectNumber} marked as Completed in KashFlow.`);
  } catch (err) {
    req.flash?.('error', `Failed to mark project ${projectNumber} complete: ${err.message}`);
  }
  res.redirect('/overview/project');
};

export default { getGeneratedArea, getGeneratedNode, getDocumentsOverview, postProjectsFinancialCheck, postProjectMarkComplete };
