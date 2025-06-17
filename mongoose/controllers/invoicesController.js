const path = require('path');
const moment = require('moment');
const mdb = require('../../services/mongoose/mongooseDatabaseService');

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
