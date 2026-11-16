// Weekly sheet import: the WEEKLY ATTENDANCE workbook into attendance.
//
// One tab per week. On each tab, row 1 has the week's dates over the day
// columns and the next row the day names (MON … SUN, columns D–J). Below
// that, one row per person: their name in column A and, under each day,
// where they were (a site, "Office", "OFF", "Holiday" …). The Sunday column
// is used for the week's hours or pay, so it isn't read as a day. The rows
// end at the notes below the grid (holidays booked, vehicles).
//
// The names and sites on the sheet are free text, so the import works in
// two steps: the upload lists every distinct name and site with a suggested
// match (an employee or subcontractor; a contract or saved location), the
// person importing checks the matches, and only then are records written.
//
// What's written follows the weekly sheet page (weeklySheetService):
//   - a site or location → work; "OFF" → off; "Sick"/"SSP" → sick
//   - holidays are not written: approved holiday requests are the record of
//     leave, and the sheet page never writes holiday attendance over them
//   - every record is pending, for the usual two-stage approval
//   - a day that already has attendance for that person is left alone, as
//     are days in a locked payroll period and days after today
//
// Everything above "Database" is pure, for testing without a database.
import mongoose from 'mongoose';
import logger from '../../services/loggerService.js';
import mdb from './mongooseDatabaseService.js';
import attendanceService from './attendanceService.js';
import { defaultDailyHours, listSubcontractors } from './weeklyFlowService.js';
import { addDays } from './weeklySheetService.js';

const DAY_COLS = [3, 4, 5, 6, 7, 8]; // D–I: Monday to Saturday
const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const STOP_WORDS = /^(hols? booked|holiday accrued|vehicle)\b/i;
const NOTE_PREFIX = 'Imported from the weekly sheet';

// ── Text ────────────────────────────────────────────────────────────────

const isDateCell = (v) => v && typeof v === 'object' && typeof v.date === 'string';

/** A cell as trimmed single-spaced text. */
export function text(v) {
  if (v == null || isDateCell(v)) return '';
  return String(v).trim().replace(/\s+/g, ' ');
}

/** Free text as a key: case and spacing don't count. */
export function keyOf(s) {
  return text(s).toLowerCase();
}

/**
 * What one day cell says.
 *   { kind: 'place', key, text }  somewhere to match to a contract or location
 *   { kind: 'off' | 'sick' }
 *   { kind: 'leave' }             holiday / bank holiday / paid leave (not imported)
 *   { kind: 'note' }              hours or money written in a day (not imported)
 *   null                          empty
 */
export function classifyCell(v) {
  const t = text(v);
  if (!t) return null;
  if (/^(day )?off$/i.test(t)) return { kind: 'off', text: t };
  if (/^(sick|ssp)\b/i.test(t)) return { kind: 'sick', text: t };
  if (/holiday|\bhols?\b|paid leave|annual leave/i.test(t)) return { kind: 'leave', text: t };
  // Only digits, hours and sums: "40 hrs", "850", "1200 - 240 = 960"
  if (/\d/.test(t) && /^[\d\s.,+\-=£/x]*(hrs?|hours)?[\d\s.,+\-=£/x]*$/i.test(t)) return { kind: 'note', text: t };
  return { kind: 'place', key: keyOf(t), text: t };
}

// ── Sheets ──────────────────────────────────────────────────────────────

/** The header row (day names) of a week tab, or -1. */
export function findHeaderRow(rows) {
  return rows.findIndex((r) => Array.isArray(r) && DAY_COLS.every((c, i) => keyOf(r[c]).startsWith(DAY_NAMES[i])));
}

/**
 * One week tab. Returns { monday, people: [{ name, row, cells: [classified|null ×6] }] }
 * or { error } when it isn't a week (no day names, or no Monday date above them).
 */
export function parseWeekSheet(sheet) {
  const rows = sheet.rows || [];
  const h = findHeaderRow(rows);
  if (h < 1) return { error: 'No MON … SAT header row' };
  const mon = rows[h - 1]?.[DAY_COLS[0]];
  if (!isDateCell(mon)) return { error: 'No date above Monday' };
  if (new Date(`${mon.date}T12:00:00Z`).getUTCDay() !== 1) return { error: `The date above Monday (${mon.date}) isn't a Monday` };

  const people = [];
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (row.some((v) => STOP_WORDS.test(text(v)))) break;
    const name = text(row[0]);
    if (!name) continue;
    const cells = DAY_COLS.map((c) => classifyCell(row[c]));
    if (!cells.some(Boolean)) continue; // group headings and unused rows
    people.push({ name, row: r + 1, cells });
  }
  return { monday: mon.date, people };
}

/** The display spelling used most often for each key. */
function spellings(counter) {
  return [...counter.entries()].map(([key, m]) => {
    const [label] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return { key, label, count: [...m.values()].reduce((a, b) => a + b, 0) };
  });
}
const tally = (counter, key, label) => {
  const m = counter.get(key) || counter.set(key, new Map()).get(key);
  m.set(label, (m.get(label) || 0) + 1);
};

/**
 * The whole workbook. Throws a 400 when no tab is a week.
 * Returns {
 *   weeks: [{ sheet, monday }], skippedSheets: [{ sheet, reason }],
 *   people: [{ key, label, count }], places: [{ key, label, count }],
 *   cells: [{ p: personIndex, day, kind, place?: placeIndex, text }],
 *   counts: { leave, note, duplicateWeeks },
 * }
 */
export function parseAttendanceWorkbook(sheets) {
  const weeks = [];
  const skippedSheets = [];
  const parsedWeeks = [];
  const seenMondays = new Set();
  let duplicateWeeks = 0;
  for (const sheet of sheets) {
    const w = parseWeekSheet(sheet);
    if (w.error) { skippedSheets.push({ sheet: sheet.name, reason: w.error }); continue; }
    if (seenMondays.has(w.monday)) {
      duplicateWeeks++;
      skippedSheets.push({ sheet: sheet.name, reason: `Same week as an earlier tab (${w.monday})` });
      continue;
    }
    seenMondays.add(w.monday);
    weeks.push({ sheet: sheet.name, monday: w.monday });
    parsedWeeks.push(w);
  }
  if (!weeks.length) {
    throw Object.assign(new Error("This doesn't look like the weekly attendance workbook: no tab has a week of dates over MON … SAT."), { status: 400 });
  }

  const peopleCount = new Map();
  const placeCount = new Map();
  for (const w of parsedWeeks) {
    for (const p of w.people) {
      tally(peopleCount, keyOf(p.name), p.name);
      for (const c of p.cells) if (c?.kind === 'place') tally(placeCount, c.key, c.text);
    }
  }
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  const people = spellings(peopleCount).sort(byLabel);
  const places = spellings(placeCount).sort((a, b) => b.count - a.count || byLabel(a, b));
  const personIndex = new Map(people.map((p, i) => [p.key, i]));
  const placeIndex = new Map(places.map((p, i) => [p.key, i]));

  // Day-cell counts per person and place go on the lists (people count rows, so recount days)
  people.forEach((p) => { p.count = 0; });
  const cells = [];
  const counts = { leave: 0, note: 0, duplicateWeeks };
  for (const w of parsedWeeks) {
    for (const p of w.people) {
      const pi = personIndex.get(keyOf(p.name));
      p.cells.forEach((c, i) => {
        if (!c) return;
        if (c.kind === 'leave' || c.kind === 'note') { counts[c.kind]++; return; }
        people[pi].count++;
        const cell = { p: pi, day: addDays(w.monday, i), kind: c.kind, text: c.text };
        if (c.kind === 'place') cell.place = placeIndex.get(c.key);
        cells.push(cell);
      });
    }
  }
  return { weeks, skippedSheets, people, places, cells, counts };
}

// ── Suggested matches ───────────────────────────────────────────────────

const words = (s) => keyOf(s).replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean);

/**
 * A sheet name's suggested person: 'e:<id>' / 's:<id>' or ''. Every word of
 * the candidate's name that the sheet name has counts (a single letter
 * matches a word starting with it); the best score wins if no one ties.
 * At least one whole word must match.
 */
export function suggestPerson(name, { employees = [], subcontractors = [] } = {}) {
  const sheetWords = words(name);
  const cands = [
    ...employees.map((e) => ({ value: `e:${e._id}`, words: words(e.name) })),
    ...subcontractors.map((s) => ({ value: `s:${s._id}`, words: words(s.Name) })),
  ];
  let best = { score: 0, values: [] };
  for (const c of cands) {
    let whole = 0;
    let score = 0;
    for (const w of sheetWords) {
      if (c.words.includes(w)) { whole++; score += 2; } else if (w.length === 1 && c.words.some((cw) => cw.startsWith(w))) score += 1;
    }
    if (!whole) continue;
    if (sheetWords.join(' ') === c.words.join(' ')) score += 10;
    if (score > best.score) best = { score, values: [c.value] };
    else if (score === best.score) best.values.push(c.value);
  }
  return best.values.length === 1 ? best.values[0] : '';
}

/**
 * A sheet site's suggested target: 'loc:<id>' for a saved location with that
 * name, 'con:<id>' for the one contract whose title is or starts with it
 * (word for word), else 'new' (a new saved location with the sheet's name).
 */
export function suggestPlace(label, { locations = [], contracts = [] } = {}) {
  const k = words(label).join(' ');
  if (!k) return '';
  const loc = locations.find((l) => words(l.name).join(' ') === k);
  if (loc) return `loc:${loc._id}`;
  const exact = contracts.filter((c) => words(c.title).join(' ') === k);
  if (exact.length === 1) return `con:${exact[0]._id}`;
  const prefix = contracts.filter((c) => (`${words(c.title).join(' ')} `).startsWith(`${k} `));
  if (prefix.length === 1) return `con:${prefix[0]._id}`;
  return 'new';
}

// ── Planning ────────────────────────────────────────────────────────────


/** A submitted person choice → { employeeId } / { subcontractorId } / null. */
export function readPersonChoice(v) {
  const m = String(v || '').match(/^([es]):([0-9a-f]{24})$/);
  if (!m) return null;
  return m[1] === 'e' ? { employeeId: m[2] } : { subcontractorId: m[2] };
}

/** A submitted place choice → { contractId } / { locationId } / { create: true } / null. */
export function readPlaceChoice(v) {
  const s = String(v || '');
  if (s === 'new') return { create: true };
  const m = s.match(/^(con|loc):([0-9a-f]{24})$/);
  if (!m) return null;
  return m[1] === 'con' ? { contractId: m[2] } : { locationId: m[2] };
}

/**
 * The records to write. Pure.
 *   cells          parsed cells
 *   personFor[i]   readPersonChoice result for person i (null = skip)
 *   placeFor[i]    { contractId, projectId?, locationId? } | { locationId } | null for place i
 *   taken          Set of "<e|s>:<id>|yyyy-mm-dd" that already have attendance
 *   lockedDays     Set of yyyy-mm-dd in locked payroll periods
 *   today          yyyy-mm-dd
 * Returns { records: [{ who, day, type, target, text }], skipped: { … counts } }.
 */
export function planAttendance({ cells, personFor, placeFor, taken = new Set(), lockedDays = new Set(), today }) {
  const skipped = { person: 0, place: 0, existing: 0, locked: 0, future: 0, duplicate: 0 };
  const records = [];
  const planned = new Set();
  for (const c of cells) {
    const who = personFor[c.p];
    if (!who) { skipped.person++; continue; }
    let target = null;
    if (c.kind === 'place') {
      target = placeFor[c.place];
      if (!target) { skipped.place++; continue; }
    }
    if (c.day > today) { skipped.future++; continue; }
    if (lockedDays.has(c.day)) { skipped.locked++; continue; }
    const whoKey = `${who.employeeId ? 'e' : 's'}:${who.employeeId || who.subcontractorId}|${c.day}`;
    if (taken.has(whoKey)) { skipped.existing++; continue; }
    if (planned.has(whoKey)) { skipped.duplicate++; continue; }
    planned.add(whoKey);
    records.push({ who, day: c.day, type: c.kind === 'place' ? 'work' : c.kind, target, text: c.text });
  }
  return { records, skipped };
}

// ── Database ────────────────────────────────────────────────────────────

const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Who and where can be chosen in the mapping. */
export async function loadChoices() {
  const [employees, subcontractors, contracts, locations] = await Promise.all([
    mdb.INTERNAL.employee.find({}).select('_id uuid name status department contract').sort({ status: 1, name: 1 }).lean(),
    listSubcontractors(),
    mdb.INTERNAL.contract.find({}).select('_id uuid title status projectId locationId').sort({ title: 1 }).lean(),
    mdb.INTERNAL.location.find({ name: { $nin: [null, ''] } }).select('_id uuid name').sort({ name: 1 }).lean(),
  ]);
  return { employees, subcontractors, contracts, locations };
}

/** Park a parsed workbook for the mapping step. Returns the import document. */
export async function stageUpload({ sheets, fileName, userId }) {
  const parsed = parseAttendanceWorkbook(sheets);
  return mdb.INTERNAL.workbookImport.create({ kind: 'weeklySheet', fileName, parsed, createdBy: userId || undefined });
}

async function findStaged(uuid) {
  const doc = await mdb.INTERNAL.workbookImport.findOne({ uuid: String(uuid || ''), kind: 'weeklySheet' }).lean();
  if (!doc) throw Object.assign(new Error('That upload has expired. Upload the workbook again.'), { status: 404 });
  return doc;
}

/** The mapping page: the parsed workbook, the choices and a suggestion for every name and site. */
export async function loadMapping(uuid) {
  const staged = await findStaged(uuid);
  const choices = await loadChoices();
  const { people, places } = staged.parsed;
  return {
    staged,
    choices,
    // Index = the field number (person_<i>); a name with no importable days isn't asked about
    people: people.map((p, index) => ({ ...p, index, suggestion: suggestPerson(p.label, choices) })).filter((p) => p.count > 0),
    places: places.map((p, index) => ({ ...p, index, suggestion: suggestPlace(p.label, choices) })),
  };
}

/** Days of `days` that fall in a locked payroll period. */
async function lockedDaysOf(days) {
  const out = new Set();
  for (const d of days) {
    if (await attendanceService.getLockedRunForDate(localDate(d))) out.add(d);
  }
  return out;
}

/** Person-days in the import's date range that already have attendance. */
async function takenPersonDays(from, to) {
  const recs = await mdb.INTERNAL.attendance.find({ date: { $gte: localDate(from), $lt: localDate(addDays(to, 1)) } })
    .select('employeeId subcontractorId date').lean();
  return new Set(recs.map((r) => `${r.employeeId ? 'e' : 's'}:${r.employeeId || r.subcontractorId}|${ymdLocal(new Date(r.date))}`));
}

/**
 * Run the import with the submitted mapping (body.person_<i>, body.place_<i>:
 * flat names, because the body parser compacts sparse bracket arrays).
 * Unknown ids count as skipped, never as errors. Returns the counts.
 */
export async function runImport(uuid, body = {}, { today } = {}) {
  const staged = await findStaged(uuid);
  if (staged.importedAt) throw Object.assign(new Error('That upload has already been imported.'), { status: 400 });
  const { people, places, cells } = staged.parsed;
  const choices = await loadChoices();

  const employees = new Map(choices.employees.map((e) => [String(e._id), e]));
  const subs = new Set(choices.subcontractors.map((s) => String(s._id)));
  const contracts = new Map(choices.contracts.map((c) => [String(c._id), c]));
  const locations = new Map(choices.locations.map((l) => [String(l._id), l]));

  const personFor = people.map((_, i) => {
    const who = readPersonChoice(body[`person_${i}`]);
    if (who?.employeeId && employees.has(who.employeeId)) return who;
    if (who?.subcontractorId && subs.has(who.subcontractorId)) return who;
    return null;
  });

  // New locations for the sites marked "new" (reusing one with the same name)
  let createdLocations = 0;
  const locationByName = new Map(choices.locations.map((l) => [keyOf(l.name), l]));
  const placeFor = [];
  for (let i = 0; i < places.length; i++) {
    const choice = readPlaceChoice(body[`place_${i}`]);
    if (!choice) { placeFor.push(null); continue; }
    if (choice.contractId) {
      const c = contracts.get(choice.contractId);
      placeFor.push(c ? { contractId: c._id, ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.locationId ? { locationId: c.locationId } : {}) } : null);
    } else if (choice.locationId) {
      placeFor.push(locations.has(choice.locationId) ? { locationId: choice.locationId } : null);
    } else {
      let loc = locationByName.get(places[i].key);
      if (!loc) {
        loc = await mdb.INTERNAL.location.create({ name: places[i].label });
        locationByName.set(places[i].key, loc);
        createdLocations++;
      }
      placeFor.push({ locationId: loc._id });
    }
  }

  const days = [...new Set(cells.map((c) => c.day))].sort();
  const todayKey = today || ymdLocal(new Date());
  const inRange = days.filter((d) => d <= todayKey);
  const [lockedDays, taken] = inRange.length
    ? await Promise.all([lockedDaysOf(inRange), takenPersonDays(inRange[0], inRange[inRange.length - 1])])
    : [new Set(), new Set()];

  const { records, skipped } = planAttendance({ cells, personFor, placeFor, taken, lockedDays, today: todayKey });

  const docs = records.map((r) => {
    const doc = { ...r.who, date: localDate(r.day), type: r.type, status: 'pending', notes: `${NOTE_PREFIX}: "${r.text}"`.slice(0, 2000) };
    if (r.target) Object.assign(doc, r.target);
    if (r.type === 'work' && r.who.employeeId) {
      const h = defaultDailyHours(employees.get(String(r.who.employeeId)));
      if (h) doc.hoursWorked = mongoose.Types.Decimal128.fromString(String(h));
    }
    return doc;
  });

  let created = 0;
  let failed = 0;
  const BATCH = 500;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    try {
      // ordered:false drops documents that fail validation and returns the rest
      const res = await mdb.INTERNAL.attendance.insertMany(batch, { ordered: false });
      created += res.length;
      failed += batch.length - res.length;
    } catch (err) {
      const ok = err.insertedDocs?.length ?? err.result?.insertedCount ?? 0;
      created += ok;
      failed += batch.length - ok;
      logger.warn(`[weeklySheetImport] ${batch.length - ok} records not written: ${err.message}`);
    }
  }

  const result = { created, failed, createdLocations, skipped, notImported: staged.parsed.counts, weeks: staged.parsed.weeks.length };
  await mdb.INTERNAL.workbookImport.updateOne({ _id: staged._id }, { $set: { importedAt: new Date(), result } });
  logger.info(`[weeklySheetImport] ${staged.fileName}: created ${created}, failed ${failed}, new locations ${createdLocations}, skipped ${JSON.stringify(skipped)}`);
  return result;
}

export default {
  text, keyOf, classifyCell, findHeaderRow, parseWeekSheet, parseAttendanceWorkbook, suggestPerson, suggestPlace,
  readPersonChoice, readPlaceChoice, planAttendance, loadChoices, stageUpload, loadMapping, runImport,
};
