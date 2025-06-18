const path = require('path');
const moment = require('moment');
const mdb = require('../services/mongooseDatabaseService');

exports.listCustomers = async (req, res, next) => {
  try {
    const customers = await mdb.customer.find().sort({ Created: -1 }).lean();
    const totalCustomers = customers.length;
    const customersWithEmail = customers.filter(c => c.Email).length;
    const recentCustomers = customers.filter(c => c.Created && moment(c.Created).isAfter(moment().subtract(30, 'days')));
    res.render(path.join('mongoose', 'customer'), {
      title: 'Customers',
      customers,
      totalCustomers,
      customersWithEmail,
      recentCustomers,
      recentCustomersCount: recentCustomers.length
    });
  } catch (error) {
    next(error);
  }
};

exports.viewCustomer = async (req, res, next) => {
  try {
    const customer = await mdb.customer.findOne({ uuid: req.params.uuid }).lean();
    if (!customer) {
      req.flash('error', 'Customer not found.');
      return res.redirect('/customers');
    }
    const invoices = await mdb.invoice.find({ CustomerID: customer.CustomerID }).lean();
    const quotes = await mdb.quote.find({ CustomerID: customer.CustomerID }).lean();
    const projects = await mdb.project.find({ CustomerID: customer.CustomerID }).lean();
    customer.invoices = invoices;
    customer.quotes = quotes;
    customer.projects = projects;
    res.render(path.join('mongoose', 'viewCustomer'), {
      title: 'Customer Overview',
      Customer: customer
    });
  } catch (error) {
    next(error);
  }
};
