const cron = require('node-cron');
require('dotenv').config();

const holidayService = require('./holidayServiceMongoose');
const logger = require('../../services/loggerService');
const fetchKFMongoose = require('../kashflowAPI/fetchKashFlowDataMongoose');
const taskService = require('../services/taskServiceMongoose');

// Cron schedule for KashFlow fetch (6:30 AM to 6:30 PM hourly in production, hourly at :30 in development)
const scheduleKashFlowData =
  process.env.NODE_ENV === 'production'
    ? '30 6-18 * * *'
    : '30 * * * *';

// Cron schedule for Bank Holiday sync (midnight daily)
const scheduleBankHoliday = '0 0 * * *';

module.exports = (req, res, next) => {
  // MongoDB-only KashFlow sync
  cron.schedule(scheduleKashFlowData, async () => {
    try {
      logger.info('Cron job started: Fetching KashFlow data (MongoDB only)...');
      await fetchKFMongoose.fetchKashFlowDataMongoose();
      logger.info('Cron job completed: KashFlow data fetched successfully.');
    } catch (error) {
      logger.error('Cron job (fetchKashFlowDataMongoose) failed: ' + error.message);
    }
  });

  // Mongoose-based Bank Holiday sync
  cron.schedule(scheduleBankHoliday, async () => {
    try {
      logger.info('Cron job started: Syncing Bank Holiday data...');
      await holidayService.syncBankHolidays();
      logger.info('Cron job completed: Bank Holiday sync successful.');
    } catch (error) {
      logger.error('Cron job (syncBankHolidays) failed: ' + error.message);
    }
  });

  // Cron schedule for processing recurring tasks (every hour)
  const scheduleRecurringTasks = '0 * * * *';

  cron.schedule(scheduleRecurringTasks, async () => {
    try {
      logger.info('Cron job started: Processing recurring tasks...');
      await taskService.processRecurringTasks();
      logger.info('Cron job completed: Recurring tasks processed successfully.');
    } catch (error) {
      logger.error('Cron job (processRecurringTasks) failed: ' + error.message);
    }
  });

  next();
};
