'use strict';

const path = require('path');
const fleetService = require('../services/fleetService');
const humanOverviewService = require('../services/humanOverviewService');
const financeOverviewService = require('../services/financeOverviewService');
const projectsOverviewService = require('../services/projectsOverviewService');
const adminOverviewService = require('../services/adminOverviewService');
const documentsOverviewService = require('../services/documentsOverviewService');
const subcontractorsOverviewService = require('../services/subcontractorsOverviewService');

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
