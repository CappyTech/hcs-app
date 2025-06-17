const path = require('path');
const moment = require('moment');
const mdb = require('../../services/mongoose/mongooseDatabaseService');

exports.listQuotes = async (req, res, next) => {
  try {
    const quotes = await mdb.quote.find().sort({ InvoiceDate: -1 }).lean();
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
