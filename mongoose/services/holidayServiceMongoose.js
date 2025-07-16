const axios = require('axios');
const moment = require('moment-timezone');
const mdb = require('./mongooseDatabaseService');
const logger = require('../../services/loggerService');

const HOLIDAY_API_URL = 'https://www.gov.uk/bank-holidays.json';

// Custom holidays are still in memory for now
const customHolidays = [
  { startDate: '2024-12-21 08:00:00', endDate: '2025-01-05 18:00:00', title: 'Company Holiday' }
];

const holidayService = {
  isDateHoliday: async (date = moment().format('YYYY-MM-DD')) => {
    try {
      // Check Bank Holidays (Mongo)
      const holiday = await mdb.holiday.findOne({ date });
      if (holiday) {
        return {
          isHoliday: true,
          reason: holiday.title,
          startDate: holiday.date.format('Do MMMM YYYY'),
          endDate: holiday.date.format('Do MMMM YYYY'),
          type: 'Bank Holiday'
        };
      }

      // Check custom holidays
      const customHoliday = customHolidays.find(h =>
        moment(date).isBetween(h.startDate, h.endDate, null, '[]')
      );

      if (customHoliday) {
        return {
          isHoliday: true,
          reason: customHoliday.title,
          startDate: customHoliday.startDate.format('Do MMMM YYYY'),
          endDate: customHoliday.endDate.format('Do MMMM YYYY'),
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
      logger.error('Error checking holiday: ' + error.message);
      return {
        isHoliday: false,
        reason: 'Error occurred while fetching holiday details',
        startDate: null,
        endDate: null,
        type: 'Error'
      };
    }
  },

  getHolidayDetailsForDate: async (date) => {
    try {
      const holiday = await mdb.holiday.findOne({ date });

      const customHoliday = customHolidays.find(h =>
        moment(date).isBetween(h.startDate, h.endDate, null, '[]')
      );

      return holiday || customHoliday || null;
    } catch (error) {
      logger.error('Error fetching holiday details for date: ' + error.message);
      return null;
    }
  },

  isTodayHoliday: async () => {
    const today = moment().format('Do MMMM YYYY');
    return await holidayService.isDateHoliday(today);
  },

  getTodayHolidayDetails: async () => {
    const today = moment().format('Do MMMM YYYY');
    return await holidayService.getHolidayDetailsForDate(today);
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

  syncBankHolidays: async () => {
    try {
      const response = await axios.get(HOLIDAY_API_URL);
      const data = response.data;

      const events = [];
      for (const division in data) {
        for (const event of data[division].events) {
          events.push({
            title: event.title,
            date: event.date,
            notes: event.notes,
            bunting: event.bunting,
            division
          });
        }
      }

      const existing = await mdb.holiday.find();
      const hasChanged = events.some(e => {
        return !existing.some(ex =>
          ex.title === e.title &&
          ex.date === e.date &&
          ex.notes === e.notes &&
          ex.bunting === e.bunting &&
          ex.division === e.division
        );
      });

      if (hasChanged) {
        await mdb.holiday.deleteMany({});
        await mdb.holiday.insertMany(events);
        logger.info('Bank holidays updated.');
      }
    } catch (error) {
      logger.error('Error syncing bank holidays: ' + error.message);
    }
  },

  getNextHoliday: async () => {
    const today = moment().startOf('day');

    try {
      // Fetch all bank holidays from DB, filter future dates
      const allHolidays = await mdb.holiday.find();

      // Filter bank holidays on or after today
      const futureBankHolidays = allHolidays.filter(h => moment(h.date).isSameOrAfter(today));

      // Map to unified format with startDate and endDate same for bank holidays
      const bankHolidayObjs = futureBankHolidays.map(h => ({
        reason: h.title,
        startDate: h.date,
        endDate: h.date,
        type: 'Bank Holiday',
        _id: h._id
      }));

      // Filter custom holidays on or after today (by startDate)
      const futureCustomHolidays = customHolidays.filter(h => moment(h.startDate).isSameOrAfter(today));

      // Merge all holidays
      const combined = [...bankHolidayObjs, ...futureCustomHolidays];

      if (combined.length === 0) return null;

      // Sort by startDate ascending
      combined.sort((a, b) => moment(a.startDate).diff(moment(b.startDate)));

      // Return earliest upcoming holiday
      return combined[0];
    } catch (error) {
      logger.error('Error fetching next holiday: ' + error.message);
      return null;
    }
  }

};

module.exports = holidayService;
