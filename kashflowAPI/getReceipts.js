const logger = require('../services/loggerService');
function getReceipts(client) {
  return new Promise((resolve, reject) => {
    const receiptsParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD
    };

    client.GetReceipts(receiptsParams, async (error, result) => {
      if (error) {
        logger.error('Error calling GetReceipts method: '+ error);
        return reject(error);
      }

      const Receipts = result.GetReceiptsResult.Invoice;

      if (Receipts && Receipts.length) {
        logger.info('Total number of receipts: '+ Receipts.length);
        resolve(Receipts);
      } else {
        //logger.info('No receipts found.');
        resolve([]);
      }
    });
  });
}

module.exports = getReceipts;