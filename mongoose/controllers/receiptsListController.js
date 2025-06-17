const path = require('path');
const moment = require('moment');
const mdb = require('../../services/mongoose/mongooseDatabaseService');

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
    // add receipt.lines to get project.ID from ProjID in receipt.lines
    let Projects = [];
    if (receipt.lines && receipt.lines.length > 0) {
      Projects = await mdb.project
        .find({ ID: { $in: receipt.lines.map(line => line.ProjID) } })
        .lean();
    }
    for (const line of receipt.lines) {
      if (line.ProjID) {
        const project = Projects.find(p => p.ID === line.ProjID);
        if (project) {
          line.Project = project;
        }
      }
    }

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
