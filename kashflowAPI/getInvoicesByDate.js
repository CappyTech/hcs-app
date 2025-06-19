const logger = require('../services/loggerService');
function getInvoicesByDate(client, startDate, endDate) {
  return new Promise((resolve, reject) => {
    const invoicesParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD,
      StartDate: startDate.toISOString(),
      EndDate: endDate.toISOString(),
    };

    client.GetInvoicesByDateRange(invoicesParams, async (error, result) => {
      if (error) {
        logger.error('Error calling GetInvoicesByDateRange method: '+ error);
        return reject(error);
      }

      const invoices = result.GetInvoicesByDateRangeResult.Invoice;

      if (invoices && invoices.length) {
        logger.info('Total number of invoices: '+ invoices.length);
        resolve(invoices);
      } else {
        //logger.info('No invoices found.');
        resolve([]);
      }
    });
  });
}

module.exports = getInvoicesByDate;