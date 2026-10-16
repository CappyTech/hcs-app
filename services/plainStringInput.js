/**
 * Coerce a request field to a plain string before it reaches a query filter.
 *
 * Express parses `field[$op]=value` in a body or query string into a nested
 * object, and Mongoose would accept that object as a query operator. A
 * token or login identifier is only ever a string, so anything else is
 * treated as absent. Callers reject the empty string.
 *
 * @param {unknown} value
 * @returns {string} the trimmed string, or '' for anything that is not one
 */
export function plainString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export default { plainString };
