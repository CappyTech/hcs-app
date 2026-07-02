"use strict";

const { fromZonedTime, formatInTimeZone, getTimezoneOffset } = require("date-fns-tz");

const TZ = "Europe/London";

/**
 * Convert an input date to a UTC instant.
 *  - Date objects and ISO strings with an explicit offset/Z are instants already.
 *  - Bare date / datetime strings (e.g. '2025-04-06') are interpreted as
 *    Europe/London wall time, matching the old moment.tz(input, TZ) behaviour.
 */
function toInstant(input) {
  if (input instanceof Date) return input;
  const s = String(input).trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);
  return fromZonedTime(s, TZ);
}

/** London wall-clock parts of an instant: { y, m (1-12), d }. */
function londonParts(instant) {
  const [y, m, d] = formatInTimeZone(instant, TZ, "yyyy-MM-dd").split("-").map(Number);
  return { y, m, d };
}

/** A London wall-time (y, m 1-12, d [, time]) as a UTC instant. */
function londonInstant(y, m, d, time = "00:00:00.000") {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return fromZonedTime(`${y}-${mm}-${dd}T${time}`, TZ);
}

/** Whether an instant falls in British Summer Time. */
function isLondonDST(instant) {
  return getTimezoneOffset(TZ, instant) !== 0; // London standard time is UTC+0
}

const displayFormat = (instant) => formatInTimeZone(instant, TZ, "do MMMM yyyy");

/**
 * Gets the current tax year based on today's date.
 * The tax year starts on April 6th.
 *
 * @returns {number} - The current tax year.
 */
function getCurrentTaxYear() {
  const { y, m, d } = londonParts(new Date());
  return (m < 4 || (m === 4 && d < 6)) ? y - 1 : y;
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
  return {
    start: londonInstant(year, 4, 6),
    end: londonInstant(year + 1, 4, 5),
  };
}

/**
 * Gets the current monthly return period for a specified tax year and month.
 *
 * @param {number} year - The tax year.
 * @param {number} month - The month (1-12).
 * @returns {Object} - Period start/end, submission window dates, display
 *   strings, days-until counters and DST flags (see field list below).
 */
function getCurrentMonthlyReturn(year, month) {
  // Tax month N runs from the 6th of calendar month (April + N - 1) …
  const startMonthsFromApril = month - 1;
  const startY = year + Math.floor((3 + startMonthsFromApril) / 12);
  const startM = ((3 + startMonthsFromApril) % 12) + 1; // 1-12
  const startOfPeriod = londonInstant(startY, startM, 6);

  // … to the 5th of the following calendar month at 23:59:59.999 London time.
  //
  // KashFlow stores dates as the UTC equivalent of midnight local time:
  //   - During BST (UTC+1): midnight BST = T23:00:00Z on the *previous* UTC day
  //     e.g. 5th Sep midnight BST = 2025-09-04T23:00:00Z
  //   - During GMT (UTC+0): midnight GMT = T00:00:00Z on the same UTC day
  //     e.g. 5th Jan midnight GMT = 2026-01-05T00:00:00Z
  //
  // Using end-of-day London time (23:59:59.999) instead of midnight covers both:
  //   - BST: endOfPeriod = 2025-09-05T22:59:59.999Z → catches T23:00:00Z on the 4th ✓
  //   - GMT: endOfPeriod = 2026-01-05T23:59:59.999Z → catches T00:00:00Z on the 5th ✓
  //
  // Without this, boundary-day records were silently dropped between months.
  const endY = startM === 12 ? startY + 1 : startY;
  const endM = startM === 12 ? 1 : startM + 1;
  const endOfPeriod = londonInstant(endY, endM, 5, "23:59:59.999");

  // CIS submission window is typically 7th–11th following the period end (which is the 5th)
  const submissionOpenDate = londonInstant(endY, endM, 7, "23:59:59.999");   // 7th of the next month
  const submissionDeadline = londonInstant(endY, endM, 11, "23:59:59.999");  // 11th of the next month
  const hmrcUpdateDate     = londonInstant(endY, endM, 16, "23:59:59.999");  // 16th of the next month

  // Whole days from now, truncated toward zero (moment .diff(…, 'days') semantics)
  const now = Date.now();
  const daysUntil = (instant) => Math.trunc((instant.getTime() - now) / 86400000);

  return {
    periodStart: startOfPeriod,
    periodEnd: endOfPeriod,
    periodStartDisplay: displayFormat(startOfPeriod),
    periodEndDisplay: displayFormat(endOfPeriod),
    submissionOpenDate,
    submissionOpenDateDisplay: displayFormat(submissionOpenDate),
    submissionOpenDateInDays: daysUntil(submissionOpenDate),
    submissionDeadline,
    submissionDeadlineDisplay: displayFormat(submissionDeadline),
    hmrcUpdateDate,
    hmrcUpdateDateDisplay: displayFormat(hmrcUpdateDate),
    submissionDeadlineInDays: daysUntil(submissionDeadline),
    hmrcUpdateDateInDays: daysUntil(hmrcUpdateDate),
    isDST: isLondonDST(startOfPeriod),
    isEndDST: isLondonDST(endOfPeriod),
  };
}

/**
 * Calculates the tax year and tax month for a given date.
 *
 * @param {string|Date} date - The date to calculate the tax year and month for.
 * @returns {Object} - An object containing the tax year and tax month.
 *   - taxYear: The tax year.
 *   - taxMonth: The tax month (1-12).
 */
const calculateTaxYearAndMonth = (date) => {
  if (!date) return { taxYear: null, taxMonth: null };

  const { y, m, d } = londonParts(toInstant(date));
  const taxYear = (m < 4 || (m === 4 && d < 6)) ? y - 1 : y;
  // Months elapsed since 6 April of the tax year, counting from 1
  let taxMonth = (y - taxYear) * 12 + (m - 4) + 1;
  if (d < 6) taxMonth -= 1;

  return { taxYear, taxMonth };
};

module.exports = {
  getCurrentTaxYear,
  getTaxYearStartEnd,
  getCurrentMonthlyReturn,
  calculateTaxYearAndMonth,
};
