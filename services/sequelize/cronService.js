const cron = require('node-cron');
require('dotenv').config();
const fetchKF = require('../../kf/fetchKashFlowData');
const fetchKFMongoose = require('../../kf/mongoose/fetchKashFlowDataMongoose');
const holidayService = require('./holidayService');
const logger = require('../loggerService');

// Cron schedule for KashFlow fetch (6:30 AM to 6:30 PM hourly in production, hourly at :30 in development)
const scheduleKashFlowData =
  process.env.NODE_ENV === 'production'
    ? '30 6-18 * * *' // every hour at HH:30 from 6 AM to 6 PM
    : '30 * * * *';   // every hour at HH:30

// Cron schedule for Bank Holiday sync (midnight daily)
const scheduleBankHoliday = '0 0 * * *';

module.exports = (req, res, next) => {
  // Schedule KashFlow sync
  cron.schedule(scheduleKashFlowData, async () => {
    try {
      logger.info('Cron job started: Fetching KashFlow data... to MySQL...');
      await fetchKF.fetchKashFlowData();
      logger.info('Cron job completed: KashFlow data fetched successfully.');
      logger.info('Cron job started: Fetching KashFlow data... to MongoDB...');
      await fetchKFMongoose.fetchKashFlowDataMongoose();
      logger.info('Cron job completed: KashFlow data fetched successfully.');
    } catch (error) {
      logger.error('Cron job (fetchKashFlowData) failed: ' + error.message);
    }
  });

  // Schedule Bank Holiday sync
  cron.schedule(scheduleBankHoliday, async () => {
    try {
      logger.info('Cron job started: Fetching Bank Holiday data...');
      await holidayService.getBankHoliday();
      logger.info('Cron job completed: Bank Holiday fetched successfully.');
    } catch (error) {
      logger.error('Cron job (getBankHoliday) failed: ' + error.message);
    }
  });

  // Continue middleware chain
  next();
};
