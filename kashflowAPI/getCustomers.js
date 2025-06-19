const logger = require('../services/loggerService');
function getCustomers(client) {
  return new Promise((resolve, reject) => {
    const customersParams = {
      UserName: process.env.KFUSERNAME,
      Password: process.env.KFPASSWORD
    };

    client.GetCustomers(customersParams, (error, result) => {
      if (error) {
        logger.error('Error calling GetCustomers method: '+ error);
        return reject(error);
      }

      const customers = result.GetCustomersResult.Customer;

      if (customers && customers.length) {
        logger.info('Total number of customers: '+ customers.length);
        resolve(customers);
      } else {
        logger.info('No customers found.');
        resolve([]);
      }
    });
  });
}

module.exports = getCustomers;