const soap = require('soap');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const logger = require('../services/loggerService');

function authenticate(context = 'main thread') {
  return new Promise((resolve, reject) => {
    soap.createClient('https://securedwebapp.com/api/service.asmx?WSDL', (err, client) => {
      if (err) {
        logger.error(`[${context}] Error creating SOAP client: ${err}`);
        return reject(err);
      }

      logger.info(`[${context}] SOAP client created successfully.`);

      const authParams = {
        UserName: process.env.KFUSERNAME,
        Password: process.env.KFPASSWORD,
        appName: process.env.appName,
        AutoAuthKey: process.env.autoAuthKey
      };

      client.AutoAuthIP(authParams, (err, result) => {
        if (err) {
          logger.error(`[${context}] Error calling AutoAuthIP: ${err}`);
          return reject(err);
        }

        if (result?.Status === 'OK') {
          logger.info(`[${context}] AutoAuthIP successful.`);
          return resolve(client);
        } else {
          logger.error(`[${context}] AutoAuthIP failed: ${result?.StatusDetail}`);
          return reject(new Error(result?.StatusDetail));
        }
      });
    });
  });
}

module.exports = authenticate;
