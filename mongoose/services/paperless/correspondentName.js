/**
 * correspondentName.js — Paperless correspondents named "<Name> (<Code>)".
 *
 * A correspondent linked to a KashFlow supplier carries the supplier's code in
 * brackets, so a glance at Paperless shows whether it came from KashFlow or was
 * made by hand, and hcs-app finds the supplier by its code rather than by a
 * name that may have been typed differently. No imports, so the sync job, the
 * reader and the draft can all use it.
 */

// Paperless limits a correspondent's name to 128 characters
const MAX = 128;
// KashFlow supplier codes: letters and digits, sometimes with - _ . or /
const CODED = /^(.*\S)\s*\(([A-Za-z0-9][A-Za-z0-9\-_./]{0,31})\)\s*$/;

/** "<Name> (<Code>)" for a KashFlow supplier, cut to fit Paperless. */
export function correspondentLabel({ Name, Code } = {}) {
  const name = String(Name || '').trim().replace(/\s+/g, ' ');
  const code = String(Code || '').trim();
  if (!code) return name.slice(0, MAX);
  const suffix = ` (${code})`;
  return `${name.slice(0, MAX - suffix.length).trim()}${suffix}`;
}

/**
 * Split a correspondent's name into the name and the code in brackets at the
 * end. `code` is null for a correspondent made by hand. A name that just ends
 * in brackets ("Smith (Plant Hire)") gives a code that matches no supplier, and
 * callers fall back to the name.
 */
export function parseCorrespondentName(raw) {
  const s = String(raw || '').trim();
  const m = CODED.exec(s);
  return m ? { name: m[1].trim(), code: m[2] } : { name: s, code: null };
}

export default { correspondentLabel, parseCorrespondentName };
