const moment = require("moment-timezone");

/**
 * Gets the current tax year based on today's date.
 * The tax year starts on April 6th.
 *
 * @returns {number} - The current tax year.
 */
function getCurrentTaxYear() {
  const today = moment.tz("Europe/London");
  const startOfTaxYear = moment.tz(
    { year: today.year(), month: 3, day: 6 },
    "Europe/London",
  ); // April 6th
  if (today.isBefore(startOfTaxYear)) {
    return startOfTaxYear.subtract(1, "years").year();
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
  const startOfTaxYear = moment.tz({ year, month: 3, day: 6 }, "Europe/London"); // 6th April of the specified year
  const endOfTaxYear = startOfTaxYear
    .clone()
    .add(1, "years")
    .subtract(1, "days"); // 5th April of the next year
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
 *   - periodStart: Date object for the start of the period.
 *   - periodEnd: Date object for the end of the period.
 *   - periodStartDisplay: The start date of the period (Do MMMM YYYY).
 *   - periodEndDisplay: The end date of the period (Do MMMM YYYY).
 *   - submissionOpenDate: Date object when submissions open (typically the 7th following period end).
 *   - submissionOpenDateDisplay: Display string (Do MMMM YYYY).
 *   - submissionOpenDateInDays: Days from today until submissions open (can be negative if passed).
 *   - submissionDeadline: Date object for the submission deadline (typically the 11th following period end).
 *   - submissionDeadlineDisplay: Display string (Do MMMM YYYY).
 *   - submissionDeadlineInDays: The number of days until the submission deadline.
 *   - hmrcUpdateDate: Date object for HMRC update (typically the 16th following period end).
 *   - hmrcUpdateDateDisplay: Display string (Do MMMM YYYY).
 *   - hmrcUpdateDateInDays: The number of days until the HMRC update date.
 *   - isDST: Whether the period start date is in Daylight Saving Time.
 *   - isEndDST: Whether the period end date is in Daylight Saving Time.
 */
function getCurrentMonthlyReturn(year, month) {
  const startOfTaxYear = moment.tz({ year, month: 3, day: 6 }, "Europe/London");
  const startOfPeriod = startOfTaxYear.clone().add(month - 1, "months");
  // End of period is the 5th of the following month at 23:59:59 London time.
  //
  // KashFlow stores dates as the UTC equivalent of midnight local time:
  //   - During BST (UTC+1): midnight BST = T23:00:00Z on the *previous* UTC day
  //     e.g. 5th Sep midnight BST = 2025-09-04T23:00:00Z
  //   - During GMT (UTC+0): midnight GMT = T00:00:00Z on the same UTC day
  //     e.g. 5th Jan midnight GMT = 2026-01-05T00:00:00Z
  //
  // Using endOf("day") (23:59:59.999 London time) instead of midnight covers both:
  //   - BST: endOfPeriod = 2025-09-05T22:59:59.999Z → catches T23:00:00Z on the 4th ✓
  //   - GMT: endOfPeriod = 2026-01-05T23:59:59.999Z → catches T00:00:00Z on the 5th ✓
  //
  // Without this, boundary-day records were silently dropped between months.
  const endOfPeriod = startOfPeriod
    .clone()
    .add(1, "months")
    .subtract(1, "days")
    .endOf("day");
  const today = moment.tz("Europe/London");

  // CIS submission window is typically 7th–11th following the period end (which is the 5th)
  const submissionOpenDate = endOfPeriod.clone().add(2, "days"); // 7th of the next month
  const submissionDeadline = endOfPeriod.clone().add(6, "days"); // 11th of the next month
  const hmrcUpdateDate = endOfPeriod.clone().add(11, "days"); // 16th of the next month

  const submissionOpenDateInDays = submissionOpenDate.diff(today, "days");
  const submissionDeadlineInDays = submissionDeadline.diff(today, "days");
  const hmrcUpdateDateInDays = hmrcUpdateDate.diff(today, "days");

  return {
    periodStart: startOfPeriod.toDate(),
    periodEnd: endOfPeriod.toDate(),
    periodStartDisplay: startOfPeriod.format("Do MMMM YYYY"),
    periodEndDisplay: endOfPeriod.format("Do MMMM YYYY"),
    submissionOpenDate: submissionOpenDate.toDate(),
    submissionOpenDateDisplay: submissionOpenDate.format("Do MMMM YYYY"),
    submissionOpenDateInDays,
    submissionDeadline: submissionDeadline.toDate(),
    submissionDeadlineDisplay: submissionDeadline.format("Do MMMM YYYY"),
    hmrcUpdateDate: hmrcUpdateDate.toDate(),
    hmrcUpdateDateDisplay: hmrcUpdateDate.format("Do MMMM YYYY"),
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

  const remittanceMoment = moment.tz(date, "Europe/London");
  const year = remittanceMoment.year();
  const startOfTaxYear = moment.tz(`${year}-04-06T00:00:00`, "Europe/London");
  const taxYear = remittanceMoment.isBefore(startOfTaxYear) ? year - 1 : year;
  const startOfCurrentTaxYear = remittanceMoment.isBefore(startOfTaxYear)
    ? moment.tz(`${year - 1}-04-06T00:00:00`, "Europe/London")
    : startOfTaxYear;
  const taxMonth = remittanceMoment.diff(startOfCurrentTaxYear, "months") + 1;

  return { taxYear, taxMonth };
};

module.exports = {
  getCurrentTaxYear,
  getTaxYearStartEnd,
  getCurrentMonthlyReturn,
  calculateTaxYearAndMonth,
};
