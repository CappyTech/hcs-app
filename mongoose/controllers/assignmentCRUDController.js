const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

exports.createAssignment = async (req, res, next) => {
  try {
    const { contractId, title, description, weekStart, assignedEmployees, assignedSubcontractors, estimatedHours, status } = req.body;

    await mdb.ContractAssignment.create({
      contractId,
      title,
      description,
      weekStart,
      assignedEmployees: Array.isArray(assignedEmployees) ? assignedEmployees : assignedEmployees ? [assignedEmployees] : [],
      assignedSubcontractors: Array.isArray(assignedSubcontractors) ? assignedSubcontractors : assignedSubcontractors ? [assignedSubcontractors] : [],
      estimatedHours,
      status
    });

    req.flash('success', 'Assignment created successfully.');
    res.redirect(`/contract/${contractId}`);
  } catch (err) {
    next(err);
  }
};

exports.readAssignment = async (req, res, next) => {
  try {
    const assignment = await mdb.ContractAssignment.findById(req.params.id)
      .populate('contractId')
      .populate('assignedEmployees')
      .populate('assignedSubcontractors');

    if (!assignment) {
      req.flash('error', 'Assignment not found.');
      return res.redirect('/contracts');
    }

    res.render(path.join('mongoose', 'assignment', 'viewAssignment'), {
      title: 'Assignment Details',
      assignment
    });
  } catch (err) {
    next(err);
  }
};

exports.updateAssignment = async (req, res, next) => {
  try {
    const { title, description, weekStart, assignedEmployees, assignedSubcontractors, estimatedHours, status } = req.body;

    const assignment = await mdb.ContractAssignment.findByIdAndUpdate(
      req.params.id,
      {
        title,
        description,
        weekStart,
        assignedEmployees: Array.isArray(assignedEmployees) ? assignedEmployees : assignedEmployees ? [assignedEmployees] : [],
        assignedSubcontractors: Array.isArray(assignedSubcontractors) ? assignedSubcontractors : assignedSubcontractors ? [assignedSubcontractors] : [],
        estimatedHours,
        status
      },
      { new: true }
    );

    if (!assignment) {
      req.flash('error', 'Assignment not found.');
      return res.redirect('/contracts');
    }

    req.flash('success', 'Assignment updated successfully.');
    res.redirect(`/contract/${assignment.contractId}`);
  } catch (err) {
    next(err);
  }
};

exports.deleteAssignment = async (req, res, next) => {
  try {
    const assignment = await mdb.ContractAssignment.findByIdAndDelete(req.params.id);
    if (!assignment) {
      req.flash('error', 'Assignment not found.');
      return res.redirect('/contracts');
    }

    req.flash('success', 'Assignment deleted successfully.');
    res.redirect(`/contract/${assignment.contractId}`);
  } catch (err) {
    next(err);
  }
};
