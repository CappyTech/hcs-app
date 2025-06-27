const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

exports.createContract = async (req, res, next) => {
  try {
    const { quoteId, title, location, startDate, endDate, status, notes } = req.body;
    await mdb.Contract.create({ quoteId: quoteId || null, title, location, startDate, endDate, status, notes });
    req.flash('success', 'Contract created successfully.');
    res.redirect('/contracts');
  } catch (err) {
    next(err);
  }
};

exports.readContract = async (req, res, next) => {
  try {
    const contract = await mdb.Contract.findById(req.params.id).populate('quoteId');
    if (!contract) {
      req.flash('error', 'Contract not found.');
      return res.redirect('/contracts');
    }
    res.render(path.join('mongoose', 'viewContract'), {
      title: 'Contract Details',
      contract
    });
  } catch (err) {
    next(err);
  }
};

exports.updateContract = async (req, res, next) => {
  try {
    const { quoteId, title, location, startDate, endDate, status, notes } = req.body;
    const contract = await mdb.Contract.findByIdAndUpdate(
      req.params.id,
      { quoteId: quoteId || null, title, location, startDate, endDate, status, notes },
      { new: true }
    );
    if (!contract) {
      req.flash('error', 'Contract not found.');
      return res.redirect('/contracts');
    }
    req.flash('success', 'Contract updated successfully.');
    res.redirect('/contracts');
  } catch (err) {
    next(err);
  }
};

exports.deleteContract = async (req, res, next) => {
  try {
    await mdb.Contract.findByIdAndDelete(req.params.id);
    req.flash('success', 'Contract deleted successfully.');
    res.redirect('/contracts');
  } catch (err) {
    next(err);
  }
};
