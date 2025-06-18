const path = require('path');
const moment = require('moment');
const mdb = require('../services/mongooseDatabaseService');

exports.listQuotes = async (req, res, next) => {
  try {
    const quotes = await mdb.quote.find().sort({ InvoiceDate: -1 }).lean();

    // Fetch customers referenced by the quotes
    const customerIds = [...new Set(quotes.map(q => q.CustomerID).filter(id => id))];
    const customers = await mdb.customer.find({ CustomerID: { $in: customerIds } }).lean();
    const customerMap = Object.fromEntries(customers.map(c => [c.CustomerID, c]));

    // Attach customer information to each quote
    quotes.forEach(q => {
      q.customer = customerMap[q.CustomerID] || null;
    });

    const totalQuotes = quotes.length;
    const recentQuotes = quotes.filter(q => q.InvoiceDate && moment(q.InvoiceDate).isAfter(moment().subtract(30, 'days')));

    res.render(path.join('mongoose', 'quote'), {
      title: 'Quotes',
      quotes,
      totalQuotes,
      recentQuotes
    });
  } catch (error) {
    next(error);
  }
};

exports.viewQuote = async (req, res, next) => {
  try {
    const quote = await mdb.quote.findOne({ uuid: req.params.uuid }).lean();
    if (!quote) {
      req.flash('error', 'Quote not found.');
      return res.redirect('/quotes');
    }
    const customer = await mdb.customer.findOne({ CustomerID: quote.CustomerID }).lean();
    res.render(path.join('mongoose', 'viewQuote'), {
      title: 'Quote Overview',
      Quote: quote,
      Customer: customer
    });
  } catch (error) {
    next(error);
  }
};
