const logger = require('../services/loggerService');
function getQuotes(client) {
  return new Promise((resolve, reject) => {
    const quotesParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD
    };

    client.GetQuotes(quotesParams, async (error, result) => {
      if (error) {
        logger.error('Error calling GetQuotes method: '+ error);
        return reject(error);
      }

      const quotes = result.GetQuotesResult.Invoice;

      if (quotes && quotes.length) {
        logger.info('Total number of quotes: '+ quotes.length);
        resolve(quotes);
      } else {
        //logger.info('No quotes found.');
        resolve([]);
      }
    });
  });
}

module.exports = getQuotes;