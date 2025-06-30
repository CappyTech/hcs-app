const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../services/loggerService');
const moment = require('moment-timezone');

// No Create, Update, Delete, nor Render due to Kashflow API.

exports.listInvoices = async (req, res, next) => {
  try {
    const invoices = await mdb.invoice.find().sort({ InvoiceDate: -1 }).lean();
    const totalInvoices = invoices.length;
    const paidInvoices = invoices.filter(i => i.Paid).length;
    const recentInvoices = invoices.filter(i => i.InvoiceDate && moment(i.InvoiceDate).isAfter(moment().subtract(30, 'days')));
    res.render(path.join('mongoose', 'invoice'), {
      title: 'Invoices',
      invoices,
      totalInvoices,
      paidInvoices,
      recentInvoices
    });
  } catch (error) {
    next(error);
  }
};

exports.viewInvoice = async (req, res, next) => {
  try {
    const invoice = await mdb.invoice.findOne({ uuid: req.params.uuid }).lean();
    if (!invoice) {
      req.flash('error', 'Invoice not found.');
      return res.redirect('/invoices');
    }
    const customer = await mdb.customer.findOne({ CustomerID: invoice.CustomerID }).lean();
    res.render(path.join('mongoose', 'viewInvoice'), {
      title: 'Invoice Overview',
      Invoice: invoice,
      Customer: customer
    });
  } catch (error) {
    next(error);
  }
};
