const moment = require('moment-timezone');

/**
 * Formats a given date string with named options passed as an array.
 *
 * @param {string|null|undefined} dateString - The date string to format.
 * @param {string[]} [options=[]] - Array of flags (e.g. ['includeTime', 'forDateInput', 'displayFormat']).
 * @param {string} [timezone='Europe/London'] - Timezone to format in.
 * @returns {string} - The formatted date string, or 'N/A' / 'Invalid date'.
 */
function slimDateTime(dateString, options = [], timezone = 'Europe/London') {
  if (!dateString) return 'N/A';

  const date = moment.tz(dateString, timezone);
  if (!date.isValid()) return 'Invalid date';

  if (options.includes('forDateInput')) {
    return date.format('YYYY-MM-DD');
  }

  if (options.includes('displayFormat')) {
    if (options.includes('includeTime')) {
      return date.format('Do MMMM YYYY HH:mm');
    }
    return date.format('Do MMMM YYYY');
  }

  const baseDate = date.format('DD/MM/YYYY');
  if (options.includes('includeTime')) {
    const time = date.format('HH:mm');
    return `${baseDate} ${time}`;
  }

  return baseDate;
}

module.exports = { slimDateTime };
