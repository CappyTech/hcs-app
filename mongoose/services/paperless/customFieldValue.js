/**
 * customFieldValue.js — a value in the JSON type a Paperless custom field
 * takes. Paperless validates by the field's data_type: a boolean field
 * refuses the string "true" ("Error performing bulk edit"), which is how
 * marking #253 as a credit note failed to tick Credit Note (field 58).
 * Pure; shared by the client and its mock.
 */

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off', '']);

/**
 * @param {string|undefined} dataType  Paperless data_type ('boolean', 'integer', 'float', 'string', 'monetary', 'date', …)
 * @param {*} value                     never null (null clears a field, and is handled by the caller)
 */
export function customFieldValue(dataType, value) {
  switch (dataType) {
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (TRUE.has(s)) return true;
      if (FALSE.has(s)) return false;
      throw new Error(`"${value}" isn't true or false`);
    }
    case 'integer': {
      const n = Number.parseInt(String(value), 10);
      if (!Number.isFinite(n)) throw new Error(`"${value}" isn't a whole number`);
      return n;
    }
    case 'float': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`"${value}" isn't a number`);
      return n;
    }
    default:
      // string, monetary ("GBP12.99"), date ("2026-01-20"), url, … and unknown
      return String(value);
  }
}

export default customFieldValue;
