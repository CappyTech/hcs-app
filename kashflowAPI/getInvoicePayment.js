const logger = require('../services/loggerService');

function getInvoicePayment(client, invoiceNumber) {
  return new Promise((resolve, reject) => {
    const invoicePaymentParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD,
      InvoiceNumber: invoiceNumber,
    };

    client.GetInvoicePayment(invoicePaymentParams, (error, result) => {
      if (error) {
        logger.error('Error calling GetInvoicePayment method: '+ error);
        return reject(error);
      }

      // Ensure we safely access the response
      const invoicePayments = result?.GetInvoicePaymentResult;
      //logger.debug('GetInvoicePayment result: ' + JSON.stringify(invoicePaymentResult, null, 2));
      if (invoicePayments === null) {
        //logger.info(`No payments found for Invoice #${invoiceNumber}`);
        return resolve([]);
      }
      if (!invoicePayments) {
        logger.warn('Unexpected API response format for GetInvoicePayment:', result);
        return resolve([]);
      }

      if (invoicePayments === 0) {
        //logger.info(`No payments found for Invoice #${invoiceNumber}`);
        return resolve([]);
      }

      resolve(invoicePayments);
    });
  });
}

module.exports = getInvoicePayment;