const logger = require('../services/loggerService');
function getSuppliers(client) {
  return new Promise((resolve, reject) => {
    const suppliersParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD
    };

    client.GetSuppliers(suppliersParams, async (error, result) => {
      if (error) {
        logger.error('Error calling GetSuppliers method: '+ error);
        return reject(error);
      }

      const suppliers = result.GetSuppliersResult.Supplier;

      if (suppliers && suppliers.length) {
        logger.info('Total number of suppliers: '+ suppliers.length);
        resolve(suppliers);
      } else {
        logger.info('No suppliers found.');
        resolve([]);
      }
    });
  });
}

module.exports = getSuppliers;
