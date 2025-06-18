const path = require('path');
const moment = require('moment');
const mdb = require('../services/mongooseDatabaseService');

exports.listProjects = async (req, res, next) => {
  try {
    const projects = await mdb.project.find().sort({ Date1: -1 }).lean();
    const totalProjects = projects.length;
    const activeProjects = projects.filter(p => p.Status === 1).length;
    const completedProjects = projects.filter(p => p.Status === 0).length;
    const recentProjects = projects.filter(p => p.Date1 && moment(p.Date1).isAfter(moment().subtract(30, 'days')));
    res.render(path.join('mongoose', 'project'), {
      title: 'Projects',
      projects,
      totalProjects,
      activeProjects,
      completedProjects,
      recentProjects
    });
  } catch (error) {
    next(error);
  }
};

exports.viewProject = async (req, res, next) => {
  try {
    const project = await mdb.project.findOne({ uuid: req.params.uuid }).lean();
    if (!project) {
      req.flash('error', 'Project not found.');
      return res.redirect('/projects');
    }
    const customer = await mdb.customer.findOne({ CustomerID: project.CustomerID }).lean();
    res.render(path.join('mongoose', 'viewProject'), {
      title: 'Project Overview',
      Project: project,
      Customer: customer
    });
  } catch (error) {
    next(error);
  }
};
