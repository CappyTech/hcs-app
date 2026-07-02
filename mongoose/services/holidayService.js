const axios = require('axios');
const { format } = require('date-fns');
const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');
const crypto = require('crypto');
const HOLIDAY_API_URL = 'https://www.gov.uk/bank-holidays.json';

// Custom holidays are still in memory for now
const customHolidays = [
  { startDate: '2024-12-21 08:00:00', endDate: '2025-01-05 18:00:00', title: 'Company Holiday' }
];

// Display format for holiday dates, tolerant of Date objects and strings
const displayDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? String(d) : format(dt, 'do MMMM yyyy');
};

const holidayService = {
  isDateHoliday: async (date = format(new Date(), 'yyyy-MM-dd')) => {
    try {
      // Check Bank Holidays (Mongo)
      const holiday = await mdb.INTERNAL.holiday.findOne({ date });
      if (holiday) {
        if (holiday.division === 'england-and-wales') {
          return {
            isHoliday: true,
            reason: holiday.title,
            startDate: displayDate(holiday.date),
            endDate: displayDate(holiday.date),
            type: 'Government Holiday',
            division: holiday.division
          };
        } else {
          return {
            isHoliday: false,
            reason: null,
            startDate: null,
            endDate: null,
            type: null,
            division: holiday.division
          };
        }
      }

      // Check custom holidays (inclusive range; NaN comparisons are false,
      // matching moment's invalid-date behaviour)
      const dateMs = new Date(date).getTime();
      const customHoliday = customHolidays.find(h =>
        dateMs >= new Date(h.startDate).getTime() && dateMs <= new Date(h.endDate).getTime()
      );

      if (customHoliday) {
        return {
          isHoliday: true,
          reason: customHoliday.title,
          startDate: displayDate(customHoliday.startDate),
          endDate: displayDate(customHoliday.endDate),
          type: 'Company Holiday'
        };
      }

      return {
        isHoliday: false,
        reason: null,
        startDate: null,
        endDate: null,
        type: null
      };
    } catch (error) {
      logger.error(`[holidayService] Error checking holiday: ${error.message}`, { stack: error.stack });
      return {
        isHoliday: false,
        reason: 'Error occurred while fetching holiday details',
        startDate: null,
        endDate: null,
        type: 'Error'
      };
    }
  },


  isTodayHoliday: async () => {
    const today = format(new Date(), 'do MMMM yyyy');
    return await holidayService.isDateHoliday(today);
  },

  addCustomHoliday: (startDate, endDate, title) => {
    if (!customHolidays.some(h => h.startDate === startDate && h.endDate === endDate)) {
      customHolidays.push({ startDate, endDate, title });
    }
  },

  removeCustomHoliday: (title) => {
    const index = customHolidays.findIndex(h => h.title === title);
    if (index !== -1) customHolidays.splice(index, 1);
  },

  getCustomHolidays: () => {
    return customHolidays;
  },

  getNextHoliday: async (division) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    if (!division) division = 'england-and-wales';
    try {
      // Fetch all bank holidays from DB, filter future dates
      const allHolidays = await mdb.INTERNAL.holiday.find();

      // Filter bank holidays on or after today
      const futureBankHolidays = allHolidays.filter(h => new Date(h.date).getTime() >= todayMs && h.division === division);

      // Map to unified format with startDate and endDate same for bank holidays
      const bankHolidayObjs = futureBankHolidays.map(h => ({
        reason: h.title,
        startDate: h.date,
        endDate: h.date,
        type: 'Bank Holiday',
        _id: h._id,
        division: h.division
      }));

      // Filter custom holidays on or after today (by startDate)
      const futureCustomHolidays = customHolidays.filter(h => new Date(h.startDate).getTime() >= todayMs);

      // Merge all holidays
      const combined = [...bankHolidayObjs, ...futureCustomHolidays];

      if (combined.length === 0) return null;

      // Sort by startDate ascending
      combined.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

      // Return earliest upcoming holiday
      return combined[0];
    } catch (error) {
      logger.error(`[holidayService] Error fetching next holiday: ${error.message}`, { stack: error.stack });
      return null;
    }
  },

  // Errors propagate to the caller — the 'bank-holiday-sync' job surfaces
  // them on /admin/jobs instead of silently logging.
  syncBankHolidays: async () => {
    const response = await axios.get(HOLIDAY_API_URL, { timeout: 15000 });
    const data = response.data;

    const bulkOps = [];

    for (const division in data) {
      for (const event of data[division].events) {
        bulkOps.push({
          updateOne: {
            filter: {
              title: event.title,
              date: event.date,
              division,
              notes: event.notes || '',
              bunting: event.bunting
            },
            update: {
              $setOnInsert: {
                uuid: crypto.randomUUID()
              }
            },
            upsert: true
          }
        });
      }
    }

    const totalEvents = bulkOps.length;

    if (totalEvents === 0) {
      logger.info('No holidays to sync.');
      return { events: 0, upserts: 0, modified: 0, unchanged: 0 };
    }

    const result = await mdb.INTERNAL.holiday.bulkWrite(bulkOps);
    const upserts = result.upsertedCount || 0;
    const modified = result.modifiedCount || 0;
    const unchanged = totalEvents - upserts - modified;

    logger.info(`Bank holidays synced. Events: ${totalEvents}, Unchanged: ${unchanged}, Upserts: ${upserts}, Modified: ${modified}`);
    return { events: totalEvents, upserts, modified, unchanged };
  },

  fetchBankHolidays: async () => {
    logger.info('Manual holiday sync triggered.');
    return await holidayService.syncBankHolidays();
  }

};

module.exports = holidayService;
