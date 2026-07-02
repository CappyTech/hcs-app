const { fromZonedTime, formatInTimeZone } = require("date-fns-tz");

/**
 * Convert an input date to a UTC instant.
 *  - Date objects and strings with an explicit offset/Z are instants already.
 *  - Bare date / datetime strings (e.g. '2025-12-25') are interpreted as wall
 *    time in the target timezone, matching the old moment.tz(input, tz)
 *    behaviour.
 */
function toInstant(input, timezone) {
  if (input instanceof Date) return input;
  const s = String(input).trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);
  try {
    return fromZonedTime(s, timezone);
  } catch {
    return new Date(NaN);
  }
}

/**
 * Formats a given date string with named options passed as an array.
 *
 * @param {string|Date|null|undefined} dateString - The date to format.
 * @param {string[]} [options=[]] - Array of flags (e.g. ['includeTime', 'forDateInput', 'displayFormat']).
 * @param {string} [timezone='Europe/London'] - Timezone to format in.
 * @returns {string} - The formatted date string, or 'Never' / 'Invalid date'.
 */
function slimDateTime(dateString, options = [], timezone = "Europe/London") {
  if (!dateString) return "Never";

  const instant = toInstant(dateString, timezone);
  if (isNaN(instant.getTime())) return "Invalid date";

  const fmt = (pattern) => formatInTimeZone(instant, timezone, pattern);

  if (options.includes("forDateInput")) {
    return fmt("yyyy-MM-dd");
  }

  if (options.includes("displayFormat")) {
    if (options.includes("includeTime")) {
      return fmt("do MMMM yyyy HH:mm");
    }
    return fmt("do MMMM yyyy");
  }

  const baseDate = fmt("dd/MM/yyyy");
  if (options.includes("includeTime")) {
    return `${baseDate} ${fmt("HH:mm")}`;
  }

  return baseDate;
}

module.exports = { slimDateTime };
