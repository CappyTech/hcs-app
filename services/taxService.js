const moment = require('moment-timezone');

/**
 * Gets the current tax year based on today's date.
 * The tax year starts on April 6th.
 * 
 * @returns {number} - The current tax year.
 */
function getCurrentTaxYear() {
    const today = moment.tz('Europe/London');
    const startOfTaxYear = moment.tz({ year: today.year(), month: 3, day: 6 }, 'Europe/London'); // April 6th
    if (today.isBefore(startOfTaxYear)) {
        return startOfTaxYear.subtract(1, 'years').year();
    }
    return startOfTaxYear.year();
}

/**
 * Gets the start and end dates of a specified tax year.
 * 
 * @param {number} year - The tax year.
 * @returns {Object} - An object containing the start and end dates of the tax year.
 *   - start: The start date of the tax year (6th April).
 *   - end: The end date of the tax year (5th April of the next year).
 */
function getTaxYearStartEnd(year) {
    const startOfTaxYear = moment.tz({ year, month: 3, day: 6 }, 'Europe/London'); // 6th April of the specified year
    const endOfTaxYear = startOfTaxYear.clone().add(1, 'years').subtract(1, 'days'); // 5th April of the next year
    return {
        start: startOfTaxYear.toDate(),
        end: endOfTaxYear.toDate(),
    };
}

/**
 * Gets the current monthly return period for a specified tax year and month.
 * 
 * @param {number} year - The tax year.
 * @param {number} month - The month (1-12).
 * @returns {Object} - An object containing the start and end dates of the period, 
 *   submission deadline, HMRC update date, and the number of days until these dates.
 *   - periodStart: The start date of the period (YYYY-MM-DD).
 *   - periodEnd: The end date of the period (YYYY-MM-DD).
 *   - periodStartDisplay: The start date of the period (Do MMMM YYYY).
 *   - periodEndDisplay: The end date of the period (Do MMMM YYYY).
 *   - submissionDeadline: The submission deadline date (Do MMMM YYYY).
 *   - hmrcUpdateDate: The HMRC update date (Do MMMM YYYY).
 *   - submissionDeadlineInDays: The number of days until the submission deadline.
 *   - hmrcUpdateDateInDays: The number of days until the HMRC update date.
 *   - isDST: Whether the period start date is in Daylight Saving Time.
 *   - isEndDST: Whether the period end date is in Daylight Saving Time.
 */
function getCurrentMonthlyReturn(year, month) {
    const startOfTaxYear = moment.tz({ year, month: 3, day: 6 }, 'Europe/London');
    const startOfPeriod = startOfTaxYear.clone().add(month - 1, 'months');
    const endOfPeriod = startOfPeriod.clone().add(1, 'months').subtract(1, 'days');
    const today = moment.tz('Europe/London');

    const submissionDeadline = endOfPeriod.clone().add(6, 'days'); // 11th of the next month
    const hmrcUpdateDate = endOfPeriod.clone().add(11, 'days'); // 16th of the next month
    const submissionDeadlineInDays = submissionDeadline.diff(today, 'days');
    const hmrcUpdateDateInDays = hmrcUpdateDate.diff(today, 'days');

    return {
        periodStart: startOfPeriod.toDate(),
        periodEnd: endOfPeriod.toDate(),
        submissionDeadline: submissionDeadline.toDate(),
        hmrcUpdateDate: hmrcUpdateDate.toDate(),
        submissionDeadlineInDays,
        hmrcUpdateDateInDays,
        isDST: startOfPeriod.isDST(),
        isEndDST: endOfPeriod.isDST(),
    };
}

/**
 * Calculates the tax year and tax month for a given date.
 * 
 * @param {string} date - The date to calculate the tax year and month for.
 * @returns {Object} - An object containing the tax year and tax month.
 *   - taxYear: The tax year.
 *   - taxMonth: The tax month (1-12).
 */
const calculateTaxYearAndMonth = (date) => {
    if (!date) return { taxYear: null, taxMonth: null };

    const remittanceMoment = moment.tz(date, 'Europe/London');
    const year = remittanceMoment.year();
    const startOfTaxYear = moment.tz(`${year}-04-06T00:00:00`, 'Europe/London');;
    const taxYear = remittanceMoment.isBefore(startOfTaxYear) ? year - 1 : year;
    const startOfCurrentTaxYear = remittanceMoment.isBefore(startOfTaxYear) ? moment.tz(`${year - 1}-04-06T00:00:00`, 'Europe/London') : startOfTaxYear;
    const taxMonth = remittanceMoment.diff(startOfCurrentTaxYear, 'months') + 1;

    return { taxYear, taxMonth };
};

module.exports = {
    getCurrentTaxYear,
    getTaxYearStartEnd,
    getCurrentMonthlyReturn,
    calculateTaxYearAndMonth,
};