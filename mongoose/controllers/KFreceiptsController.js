const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../services/loggerService');
const moment = require('moment-timezone');

// No Create, Update, Delete, nor Render due to Kashflow API.

exports.listReceipts = async (req, res, next) => {
  try {
    const receipts = await mdb.receipt.find().sort({ InvoiceDate: -1 }).lean();
    const totalReceipts = receipts.length;
    const recentReceipts = receipts.filter(r => r.InvoiceDate && moment(r.InvoiceDate).isAfter(moment().subtract(30, 'days')));
    res.render(path.join('mongoose', 'receipt'), {
      title: 'Receipts',
      receipts,
      totalReceipts,
      recentReceipts
    });
  } catch (error) {
    next(error);
  }
};

exports.viewReceipt = async (req, res, next) => {
  try {
    const receipt = await mdb.receipt.findOne({ uuid: req.params.uuid }).lean();
    if (!receipt) {
      req.flash('error', 'Receipt not found.');
      return res.redirect('/receipts');
    }
    // normalize receipt lines and fetch related projects
    const lines = Array.isArray(receipt.Lines)
      ? receipt.Lines
      : (receipt.Lines?.Line
          ? (Array.isArray(receipt.Lines.Line)
              ? receipt.Lines.Line
              : [receipt.Lines.Line])
          : []);
    let Projects = [];
    if (lines.length > 0) {
      Projects = await mdb.project
        .find({ ID: { $in: lines.map(line => line.ProjID) } })
        .lean();
    }
    for (const line of lines) {
      if (line.ProjID) {
        const project = Projects.find(p => p.ID === line.ProjID);
        if (project) {
          line.Project = project;
        }
      }
    }

    // ensure view has normalized lines
    receipt.Lines = lines;

    const supplier = await mdb.supplier.findOne({ SupplierID: receipt.CustomerID }).lean();
    res.render(path.join('mongoose', 'viewReceipt'), {
      title: 'Receipt Overview',
      Receipt: receipt,
      Supplier: supplier,
      Projects
    });
  } catch (error) {
    next(error);
  }
};

exports.changeReceipts = async (req, res, next) => {
  try {
    const { submissionDate, uuids, redirectPath } = req.body;
    const targetUUIDs = uuids && uuids.length ? (Array.isArray(uuids) ? uuids : [uuids]) : [];

    if (targetUUIDs.length === 0) {
      req.flash('error', 'No receipts selected.');
      return res.redirect(redirectPath || '/mdb/CIS');
    }

    await mdb.receipt.updateMany(
      { uuid: { $in: targetUUIDs } },
      { $set: { SubmissionDate: submissionDate ? new Date(submissionDate) : null } }
    );

    res.redirect(redirectPath || '/mdb/CIS');
  } catch (error) {
    next(error);
  }
};

