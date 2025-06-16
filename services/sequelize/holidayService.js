const axios = require('axios');
const moment = require('moment');
const db = require('./sequelizeDatabaseService');

const HOLIDAY_API_URL = 'https://www.gov.uk/bank-holidays.json';

// Custom user-defined holidays
const customHolidays = [
    { startDate: '2024-12-21 08:00:00', endDate: '2025-01-05 18:00:00', title: 'Company Holiday' }
];

const holidayService = {
    /**
     * Check if a specific date is a holiday (bank holiday or custom holiday).
     * @param {string} date - The date to check (in YYYY-MM-DD format).
     * @param {string} [region='england-and-wales'] - The region to check.
     * @returns {Promise<boolean>} - Resolves true if the date is a holiday, otherwise false.
     */
    isDateHoliday: async (date = moment().format('YYYY-MM-DD'), region = 'england-and-wales') => {
        try {
            // Fetch bank holidays data
            const response = await axios.get(HOLIDAY_API_URL);
            const bankHolidays = response.data;
    
            // Check bank holidays
            const regionHolidays = bankHolidays[region]?.events || [];
            const bankHolidayDetails = regionHolidays.find(holiday => holiday.date === date);
    
            if (bankHolidayDetails) {
                return {
                    isHoliday: true,
                    reason: bankHolidayDetails.title,
                    startDate: bankHolidayDetails.date,
                    endDate: bankHolidayDetails.date,
                    type: 'Bank Holiday'
                };
            }
    
            // Check custom holidays
            const customHolidayDetails = customHolidays.find(holiday =>
                moment(date).isBetween(
                    holiday.startDate,
                    holiday.endDate,
                    null,
                    '[]'
                )
            );
    
            if (customHolidayDetails) {
                return {
                    isHoliday: true,
                    reason: customHolidayDetails.title,
                    startDate: customHolidayDetails.startDate,
                    endDate: customHolidayDetails.endDate,
                    type: 'Company Holiday'
                };
            }
    
            // If no holiday found
            return {
                isHoliday: false,
                reason: null,
                startDate: null,
                endDate: null,
                type: null
            };
        } catch (error) {
            logger.error('Error checking holiday:', error.message);
            return {
                isHoliday: false,
                reason: 'Error occurred while fetching holiday details',
                startDate: null,
                endDate: null,
                type: 'Error'
            };
        }
    },
    

    /**
     * Fetch details of the holiday if the provided date is a holiday.
     * @param {string} date - The date to check (in YYYY-MM-DD format).
     * @param {string} [region='england-and-wales'] - The region to check.
     * @returns {Promise<Object|null>} - Resolves with holiday details or null if not a holiday.
     */
    getHolidayDetailsForDate: async (date, region = 'england-and-wales') => {
        try {
            // Fetch bank holidays data
            const response = await axios.get(HOLIDAY_API_URL);
            const bankHolidays = response.data;

            // Validate region
            if (!bankHolidays[region]) {
                throw new Error(`Region "${region}" not found.`);
            }

            // Check bank holidays
            const regionHolidays = bankHolidays[region].events;
            const bankHoliday = regionHolidays.find(holiday => holiday.date === date);

            // Check custom holidays
            const customHoliday = customHolidays.find(holiday => holiday.date === date);

            return bankHoliday || customHoliday || null;
        } catch (error) {
            logger.error('Error fetching holiday details for date:', error.message);
            return null;
        }
    },

    /**
     * Check if today is a holiday.
     * @param {string} [region='england-and-wales'] - The region to check.
     * @returns {Promise<boolean>} - Resolves true if today is a holiday, otherwise false.
     */
    isTodayHoliday: async (region = 'england-and-wales') => {
        const today = moment().format('YYYY-MM-DD');
        return await holidayService.isDateHoliday(today, region);
    },

    /**
     * Fetch details of today's holiday if it is a holiday.
     * @param {string} [region='england-and-wales'] - The region to check.
     * @returns {Promise<Object|null>} - Resolves with holiday details or null if not a holiday.
     */
    getTodayHolidayDetails: async (region = 'england-and-wales') => {
        const today = moment().format('YYYY-MM-DD');
        return await holidayService.getHolidayDetailsForDate(today, region);
    },

    /**
     * Add a custom holiday.
     * @param {string} date - The date of the custom holiday in 'YYYY-MM-DD' format.
     * @param {string} title - The title or description of the custom holiday.
     */
    addCustomHoliday: (date, title) => {
        if (!customHolidays.some(holiday => holiday.date === date)) {
            customHolidays.push({ date, title });
        }
    },

    /**
     * Remove a custom holiday.
     * @param {string} date - The date of the custom holiday to remove in 'YYYY-MM-DD' format.
     */
    removeCustomHoliday: (date) => {
        const index = customHolidays.findIndex(holiday => holiday.date === date);
        if (index !== -1) {
            customHolidays.splice(index, 1);
        }
    },

    /**
     * Get all custom holidays.
     * @returns {Array} - List of custom holidays.
     */
    getCustomHolidays: () => {
        return customHolidays;
    },

    getBankHoliday: async () => {
        try {
            const response = await axios.get(HOLIDAY_API_URL);
            const data = response.data;

            const events = [];
            for (const division in data) {
                data[division].events.forEach(event => {
                    events.push({
                        title: event.title,
                        date: event.date,
                        notes: event.notes,
                        bunting: event.bunting,
                        division: division
                    });
                });
            }

            const existingData = await db.BankHoliday.findAll();

            const hasChanged = events.some(event => {
                return !existingData.some(existingEvent => 
                    existingEvent.title === event.title &&
                    existingEvent.date === event.date &&
                    existingEvent.notes === event.notes &&
                    existingEvent.bunting === event.bunting &&
                    existingEvent.division === event.division
                );
            });

            if (hasChanged) {
                await db.BankHoliday.destroy({ where: {}, truncate: true });
                await db.BankHoliday.bulkCreate(events);
            }
        } catch (error) {
            logger.error('Error fetching or updating bank holidays:', error);
        }
    },
};

module.exports = holidayService;
