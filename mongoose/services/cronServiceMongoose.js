// cronJobs.js
const cron = require('node-cron');
require('dotenv').config();
const { getIo } = require('../../services/socketService');
const holidayService = require('./holidayServiceMongoose');
const logger = require('../../services/loggerService');
const fetchKFMongoose = require('../kashflowAPI/fetchKashFlowDataMongoose');
const taskService = require('../services/taskServiceMongoose');

function sendUpdate(message) {
  try {
    const io = getIo();
    io.to('admins').emit('logs:update', {
      level: 'info',
      entry: {
        timestamp: new Date().toISOString(),
        message,
        user: { username: 'system' }
      },
    });
  } catch (err) {
    logger.error(`Failed to emit socket update: ${err.message}`);
  }
}

function startCronJobs() {
  const scheduleKashFlowData = process.env.NODE_ENV === 'production'
    ? '30 6-18 * * *'
    : '30 * * * *';

  cron.schedule(scheduleKashFlowData, async () => {
    try {
      logger.info('Cron job started: Fetching KashFlow data (MongoDB only)...');
      await fetchKFMongoose.fetchKashFlowDataMongoose(sendUpdate);
      logger.info('Cron job completed: KashFlow data fetched successfully.');
    } catch (error) {
      logger.error('Cron job (fetchKashFlowDataMongoose) failed: ' + error.message);
    }
  });

  cron.schedule('0 0 * * *', async () => {
    try {
      logger.info('Cron job started: Syncing Bank Holiday data...');
      await holidayService.syncBankHolidays();
      logger.info('Cron job completed: Bank Holiday sync successful.');
    } catch (error) {
      logger.error('Cron job (syncBankHolidays) failed: ' + error.message);
    }
  });

  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('Cron job started: Processing recurring tasks...');
      await taskService.processRecurringTasks();
      logger.info('Cron job completed: Recurring tasks processed successfully.');
    } catch (error) {
      logger.error('Cron job (processRecurringTasks) failed: ' + error.message);
    }
  });
}

module.exports = startCronJobs;
