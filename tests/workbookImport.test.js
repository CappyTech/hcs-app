// Workbook imports: the Job Reg and weekly attendance spreadsheets.
// All names, sites and numbers here are invented.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import ExcelJS from 'exceljs';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import { readWorkbook, flattenValue, dayOf, isXlsxUpload } from '../mongoose/services/xlsxReaderService.js';
import jobImport, {
  cellText, cellInt, cellMoney, cellDate, siteKey, parseRow, pairQuotesWithJobs, parseJobRegWorkbook,
  planImport, summarisePlan, toModelFields, applyChosenPairs, suggestPairs,
} from '../mongoose/services/jobRegisterImportService.js';
import sheetImport, {
  classifyCell, parseWeekSheet, parseAttendanceWorkbook, suggestPerson, suggestPlace,
  readPersonChoice, readPlaceChoice, planAttendance,
} from '../mongoose/services/weeklySheetImportService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = (date) => ({ date });

// ── Reader ──────────────────────────────────────────────────────────────

describe('xlsx reader', () => {
  it('flattens dates, formulas and rich text', () => {
    assert.deepEqual(flattenValue(new Date('2026-03-02T00:00:00Z')), D('2026-03-02'));
    assert.deepEqual(flattenValue(new Date('2026-03-01T23:59:59.990Z')), D('2026-03-02'));
    assert.equal(flattenValue({ formula: 'A1*2', result: 42 }), 42);
    assert.equal(flattenValue({ richText: [{ text: '12 ' }, { text: 'Test St' }] }), '12 Test St');
    assert.equal(flattenValue({ error: '#REF!' }), null);
    assert.equal(dayOf(new Date('2026-07-04T00:00:00Z')), '2026-07-04');
  });

  it('accepts only .xlsx uploads', () => {
    assert.ok(isXlsxUpload({ originalname: 'Book.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    assert.ok(!isXlsxUpload({ originalname: 'Book.xls', mimetype: 'application/vnd.ms-excel' }));
    assert.ok(!isXlsxUpload({ originalname: 'evil.xlsx', mimetype: 'text/html' }));
  });

  it('reads every sheet as rows indexed from column A', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quotes 26');
    ws.getCell('B3').value = new Date(Date.UTC(2026, 0, 15));
    ws.getCell('C3').value = 50001;
    ws.getCell('D3').value = '1 Test Street';
    ws.getCell('G3').value = { formula: '100*2', result: 200 };
    wb.addWorksheet('Empty');
    const sheets = await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.deepEqual(sheets.map((s) => s.name), ['Quotes 26', 'Empty']);
    const row = sheets[0].rows[2];
    assert.deepEqual(row[1], D('2026-01-15'));
    assert.equal(row[2], 50001);
    assert.equal(row[3], '1 Test Street');
    assert.equal(row[6], 200);
    assert.deepEqual(sheets[0].rows[0], []);
  });

  it('refuses a file that is not a workbook', async () => {
    await assert.rejects(readWorkbook(Buffer.from('not a zip')), (e) => e.status === 400);
  });
});

// ── Job Reg ─────────────────────────────────────────────────────────────

// Quotes: B date · C number · D site · E client · F contact · G value · H desc · I invoice · J inv date
const quoteRow = (n, site, client, value, extra = {}) => {
  const r = [];
  r[1] = extra.date ?? D('2026-01-10'); r[2] = n; r[3] = site; r[4] = client; r[5] = extra.contact ?? 'Pat';
  r[6] = value; r[7] = extra.desc ?? 'Paving'; r[8] = extra.invoice; r[9] = extra.invDate;
  return r;
};
// Job Reg: A number · B date · C site · D client · E contact · F value · G desc · H invoice · I inv date · J ref · K, L notes
const jobRow = (n, site, client, value, extra = {}) => [
  n, extra.date ?? D('2026-02-01'), site, client, extra.contact ?? 'Pat', value, extra.desc ?? 'Paving',
  extra.invoice, extra.invDate, extra.ref, extra.k, extra.l,
];

describe('Job Reg cells', () => {
  it('reads numbers, money, dates and text', () => {
    assert.equal(cellText('  a   b '), 'a b');
    assert.equal(cellText(D('2026-03-04')), '04/03/2026');
    assert.equal(cellInt(41001), 41001);
    assert.equal(cellInt('41001'), 41001);
    assert.equal(cellInt('INV done'), null);
    assert.equal(cellInt(12.5), null);
    assert.equal(cellMoney(1234.567), 1234.57);
    assert.equal(cellMoney('£1,250.00'), 1250);
    assert.equal(cellMoney('Text to someone'), null);
    assert.equal(cellDate(D('2026-05-06')), '2026-05-06');
    assert.equal(cellDate('02/10/2026+J153'), '2026-10-02');
    assert.equal(cellDate('01.06.27'), '2027-06-01');
    assert.equal(cellDate('31/02/2026'), null);
    assert.equal(siteKey(' 12  Test St., Townville '), '12 test st townville');
  });

  it('skips pre-numbered blank rows and rows with no number', () => {
    assert.equal(parseRow(jobRow(41002, null, null, null), 'job', 5), null);
    assert.equal(parseRow(jobRow(null, '1 Test St', 'Example Homes', 10), 'job', 5), null);
  });

  it('keeps text from number columns as notes, and reads Cancelled', () => {
    const q = parseRow(quoteRow(50002, '2 Test St', 'Example Homes', 'Text to someone', { invoice: 'Cancelled' }), 'quote', 3);
    assert.equal(q.value, null);
    assert.equal(q.cancelled, true);
    assert.match(q.notes, /Value: Text to someone/);
    const j = parseRow(jobRow(41003, '3 Test St', 'Example Homes', 500, { invoice: 'INV done', invDate: 'repairs', ref: 77001, k: 'Paint to do', l: 'AB' }), 'job', 4);
    assert.equal(j.invoiceNumber, undefined);
    assert.equal(j.clientRef, '77001');
    assert.equal(j.notes, 'Invoice: INV done; Invoice date: repairs; Paint to do; AB');
    const inv = parseRow(jobRow(41004, '4 Test St', 'Example Homes', 500, { invoice: 1700, invDate: D('2026-03-01') }), 'job', 5);
    assert.equal(inv.invoiceNumber, 1700);
    assert.equal(inv.invoiceDate, '2026-03-01');
  });

  it('flags a row with no site or client', () => {
    assert.equal(parseRow(quoteRow(50003, '5 Test St', '', 100), 'quote', 6).problem, 'No client');
  });
});

describe('Job Reg pairing', () => {
  const q = (n, site, client, value) => ({ kind: 'quote', quoteNumber: n, site, client, value });
  const j = (n, site, client, value) => ({ kind: 'job', projectNumber: n, site, client, value });

  it('pairs a job with its quote by site, client and value, ignoring case and punctuation', () => {
    const r = pairQuotesWithJobs([q(1, '1 Test St.', 'Example Homes', 100), q(2, '2 Test St', 'Example Homes', 50)], [j(10, '1 test st', 'example homes ', 100)]);
    assert.equal(r.pairs.length, 1);
    assert.equal(r.pairs[0].quote.quoteNumber, 1);
    assert.deepEqual(r.quotes.map((e) => e.quoteNumber), [2]);
    assert.equal(r.jobs.length, 0);
  });

  it('pairs repeat jobs in number order and leaves uneven groups apart', () => {
    const even = pairQuotesWithJobs([q(2, 'A', 'C', 10), q(1, 'A', 'C', 10)], [j(20, 'A', 'C', 10), j(21, 'A', 'C', 10)]);
    assert.deepEqual(even.pairs.map((p) => [p.quote.quoteNumber, p.job.projectNumber]), [[1, 20], [2, 21]]);
    const uneven = pairQuotesWithJobs([q(1, 'A', 'C', 10), q(2, 'A', 'C', 10)], [j(20, 'A', 'C', 10)]);
    assert.equal(uneven.pairs.length, 0);
    assert.equal(uneven.ambiguous.length, 1);
  });

  it('never pairs on a missing value', () => {
    assert.equal(pairQuotesWithJobs([q(1, 'A', 'C', null)], [j(20, 'A', 'C', null)]).pairs.length, 0);
  });

  it('suggests near matches: same site and client at a new price, or same price at a site written differently', () => {
    const s = suggestPairs(
      [q(1, '7 Test Road', 'Example Homes', 100), q(2, 'Oak Court, Townville', 'Example Homes', 900), q(3, 'Elm Way', 'Other Ltd', 5)],
      [j(10, '7 Test Road', 'Example Homes', 120), j(11, 'Oak Court', 'Example Homes', 900), j(12, 'Elm Way', 'Example Homes', 5)],
    );
    assert.deepEqual(s.map((x) => [x.quoteNumber, x.projectNumber, x.likely]), [[1, 10, true], [2, 11, false]]);
  });

  it('merges ticked suggestions into one row, ignoring anything not offered', () => {
    const entries = [q(1, 'A', 'C', 100), j(10, 'A', 'C', 120), q(2, 'B', 'C', 5)];
    entries.forEach((e) => { e.notes = ''; e.cancelled = false; });
    const out = applyChosenPairs(entries, ['1:10', '2:99', 'junk']);
    assert.equal(out.length, 2);
    const pair = out.find((e) => e.kind === 'pair');
    assert.equal(pair.quoteNumber, 1);
    assert.equal(pair.projectNumber, 10);
    assert.equal(pair.value, 120); // the job's value wins
  });

  it('reads the whole workbook: pairs, lone rows, repeats and problems', () => {
    const quotes = { name: 'Quotes 26', rows: [
      [], quoteRow(null, 'Site:', 'Client:', 'Value:'),
      quoteRow(50010, '1 Test St', 'Example Homes', 1000),
      quoteRow(50011, '2 Test St', 'Example Homes', 300),
      quoteRow(50011, '2 Test St again', 'Example Homes', 300),
      quoteRow(50012, null, null, null),
    ] };
    const jobs = { name: 'Job Reg 26', rows: [[], jobRow(41010, '1 Test St', 'Example Homes', 1000, { invoice: 1800, invDate: D('2026-04-01') }), jobRow(41011, '9 Other Rd', 'Example Homes', 50)] };
    const p = parseJobRegWorkbook([quotes, jobs, { name: 'Sheet1', rows: [] }]);
    assert.deepEqual(p.sheets, { quotes: 'Quotes 26', jobs: 'Job Reg 26' });
    assert.deepEqual(p.counts, { quotes: 2, jobs: 2, pairs: 1, ambiguous: 0 });
    assert.deepEqual(p.entries.map((e) => e.kind), ['pair', 'job', 'quote']);
    const pair = p.entries[0];
    assert.equal(pair.quoteNumber, 50010);
    assert.equal(pair.projectNumber, 41010);
    assert.equal(pair.quoteDate, '2026-01-10');
    assert.equal(pair.jobDate, '2026-02-01');
    assert.equal(pair.invoiceNumber, 1800);
    assert.equal(p.problems.length, 1);
    assert.match(p.problems[0].problem, /repeated/);
  });

  it('refuses a workbook with neither sheet', () => {
    assert.throws(() => parseJobRegWorkbook([{ name: 'Budget', rows: [] }]), (e) => e.status === 400);
  });
});

describe('Job Reg planning', () => {
  const entry = (over) => ({ kind: 'job', site: 'A', client: 'C', value: 10, notes: '', cancelled: false, ...over });

  it('creates new rows and fills only the empty fields of existing ones', () => {
    const existing = [
      { _id: 'x1', quoteNumber: 50001, site: 'A', client: 'C', value: 10 },
      { _id: 'x2', projectNumber: 41002, site: 'B', client: 'C', value: 99, contact: 'Kept' },
    ];
    const plan = planImport([
      entry({ kind: 'pair', quoteNumber: 50001, projectNumber: 41001, jobDate: '2026-02-01', contact: 'Pat' }),
      entry({ projectNumber: 41002, value: 5, contact: 'New' }),
      entry({ projectNumber: 41003 }),
    ], existing);
    assert.deepEqual(plan.map((p) => p.action), ['update', 'same', 'create']);
    assert.deepEqual(plan[0].fill, { projectNumber: 41001, jobDate: '2026-02-01', contact: 'Pat' });
    assert.deepEqual(summarisePlan(plan), { create: 1, update: 1, same: 1, conflict: 0 });
  });

  it('reports a quote and job that are separate register rows, or a row with another number', () => {
    const existing = [{ _id: 'a', quoteNumber: 50001 }, { _id: 'b', projectNumber: 41001 }, { _id: 'c', quoteNumber: 50009, projectNumber: 41009 }];
    const plan = planImport([
      entry({ kind: 'pair', quoteNumber: 50001, projectNumber: 41001 }),
      entry({ kind: 'pair', quoteNumber: 50008, projectNumber: 41009 }),
    ], existing);
    assert.deepEqual(plan.map((p) => p.action), ['conflict', 'conflict']);
  });

  it('turns an entry into model fields with dates at noon UTC', () => {
    const f = toModelFields({ kind: 'job', row: 3, projectNumber: 41001, jobDate: '2026-02-01', site: 'A', client: 'C', contact: '', value: null, cancelled: false });
    assert.deepEqual(Object.keys(f).sort(), ['client', 'jobDate', 'projectNumber', 'site']);
    assert.equal(f.jobDate.toISOString(), '2026-02-01T12:00:00.000Z');
  });
});

// ── Weekly attendance ───────────────────────────────────────────────────

// A week tab: row 1 dates over D–J, row 2 day names, then one row per person
const weekTab = (name, monday, people, { extraRows = [] } = {}) => {
  const days = Array.from({ length: 7 }, (_, i) => D(new Date(Date.parse(`${monday}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10)));
  return {
    name,
    rows: [
      [null, null, null, ...days],
      ['WEEKEND', 'Holidays', 'HOLIDAY', 'MON', 'TUES', 'WED', 'THURS', 'FRI', 'SAT', 'SUN', 'CONTRACTS'],
      ['OFFICE', null, 'Date'],
      ...people.map(([who, ...cells]) => [who, null, null, ...cells]),
      ...extraRows,
    ],
  };
};

describe('Weekly sheet cells', () => {
  it('tells sites from off, sick, holiday and numbers', () => {
    assert.deepEqual(classifyCell('  7 Test  Road '), { kind: 'place', key: '7 test road', text: '7 Test Road' });
    assert.equal(classifyCell('OFF ').kind, 'off');
    assert.equal(classifyCell('Sick').kind, 'sick');
    assert.equal(classifyCell('SSP').kind, 'sick');
    assert.equal(classifyCell('Bank Holiday').kind, 'leave');
    assert.equal(classifyCell('16 hrs hols').kind, 'leave');
    assert.equal(classifyCell('40 Hrs').kind, 'note');
    assert.equal(classifyCell('1200 - 240 = 960').kind, 'note');
    assert.equal(classifyCell('11 Test Close').kind, 'place');
    assert.equal(classifyCell(''), null);
  });

  it('reads a week tab: Monday to Saturday, stopping at the notes below', () => {
    const tab = weekTab('11 JAN 26', '2026-01-05', [
      ['A PERSON', 'Office', 'Office', 'OFF', 'Site One', 'Site One', null, '40 hrs'],
      ['LANDSCAPING'],
      ['B Person', 'Holiday', null, null, null, null, null, null],
    ], { extraRows: [[null, null, null, null, null, null, 'Hols Booked'], ['C Person', null, null, 'Office']] });
    const w = parseWeekSheet(tab);
    assert.equal(w.monday, '2026-01-05');
    assert.deepEqual(w.people.map((p) => p.name), ['A PERSON', 'B Person']);
    assert.equal(w.people[0].cells.length, 6); // the Sunday total isn't a day
    assert.equal(w.people[0].cells[2].kind, 'off');
  });

  it('skips tabs that are not a week', () => {
    assert.ok(parseWeekSheet({ name: 'Sheet1', rows: [[]] }).error);
    const notMonday = weekTab('x', '2026-01-06', []);
    assert.match(parseWeekSheet(notMonday).error, /isn't a Monday/);
  });

  it('reads the workbook: distinct names and sites, one cell per day', () => {
    const p = parseAttendanceWorkbook([
      weekTab('18 JAN 26', '2026-01-12', [['A Person', 'Site One', 'site one', null, null, null, null], ['Sam Sub', 'Site Two', 'Bank Holiday', '40', null, null, null]]),
      weekTab('11 JAN 26', '2026-01-05', [['a person', 'Office', 'Sick', null, null, null, null]]),
      weekTab('11 JAN copy', '2026-01-05', [['A Person', 'Office']]),
      { name: 'Sheet1', rows: [] },
    ]);
    assert.equal(p.weeks.length, 2);
    assert.equal(p.counts.duplicateWeeks, 1);
    assert.equal(p.skippedSheets.length, 2);
    assert.deepEqual(p.people.map((x) => [x.label, x.count]), [['A Person', 4], ['Sam Sub', 1]]);
    assert.deepEqual(p.places.map((x) => [x.label, x.count]), [['Site One', 2], ['Office', 1], ['Site Two', 1]]);
    assert.deepEqual(p.counts, { leave: 1, note: 1, duplicateWeeks: 1 });
    const tue = p.cells.find((c) => c.day === '2026-01-13');
    assert.equal(tue.kind, 'place');
    assert.equal(p.places[tue.place].label, 'Site One');
    assert.equal(p.cells.find((c) => c.day === '2026-01-06').kind, 'sick');
  });

  it('refuses a workbook with no week tabs', () => {
    assert.throws(() => parseAttendanceWorkbook([{ name: 'Sheet1', rows: [] }]), (e) => e.status === 400);
  });
});

describe('Weekly sheet suggestions', () => {
  const employees = [{ _id: 'e1', name: 'Alex Smith' }, { _id: 'e2', name: 'Alex Jones' }, { _id: 'e3', name: 'Robin Green' }];
  const subcontractors = [{ _id: 's1', Name: 'Sam Example' }];

  it('suggests a person when one name scores best', () => {
    assert.equal(suggestPerson('ROBIN', { employees, subcontractors }), 'e:e3');
    assert.equal(suggestPerson('R Green', { employees, subcontractors }), 'e:e3');
    assert.equal(suggestPerson('Alex Jones', { employees, subcontractors }), 'e:e2');
    assert.equal(suggestPerson('XY SAM', { employees, subcontractors }), 's:s1');
    assert.equal(suggestPerson('Alex', { employees, subcontractors }), ''); // two Alexes
    assert.equal(suggestPerson('Nobody', { employees, subcontractors }), '');
  });

  it('suggests a location by name, a contract by title, else a new location', () => {
    const locations = [{ _id: 'l1', name: 'Office' }];
    const contracts = [{ _id: 'c1', title: '27 Test Square, Townville' }, { _id: 'c2', title: 'Oak Court' }, { _id: 'c3', title: 'Oak Court Phase 2' }];
    assert.equal(suggestPlace('office', { locations, contracts }), 'loc:l1');
    assert.equal(suggestPlace('27 Test Square', { locations, contracts }), 'con:c1');
    assert.equal(suggestPlace('Oak Court', { locations, contracts }), 'con:c2');
    assert.equal(suggestPlace('27 Test', { locations, contracts }), 'con:c1');
    assert.equal(suggestPlace('Elsewhere', { locations, contracts }), 'new');
  });

  it('reads the submitted choices strictly', () => {
    const id = 'a'.repeat(24);
    assert.deepEqual(readPersonChoice(`e:${id}`), { employeeId: id });
    assert.deepEqual(readPersonChoice(`s:${id}`), { subcontractorId: id });
    assert.equal(readPersonChoice('e:nope'), null);
    assert.deepEqual(readPlaceChoice(`con:${id}`), { contractId: id });
    assert.deepEqual(readPlaceChoice(`loc:${id}`), { locationId: id });
    assert.deepEqual(readPlaceChoice('new'), { create: true });
    assert.equal(readPlaceChoice(''), null);
  });
});

describe('Weekly sheet planning', () => {
  const cells = [
    { p: 0, day: '2026-01-05', kind: 'place', place: 0, text: 'Site One' },
    { p: 0, day: '2026-01-06', kind: 'off', text: 'OFF' },
    { p: 0, day: '2026-01-07', kind: 'place', place: 1, text: 'Skipped site' },
    { p: 1, day: '2026-01-05', kind: 'place', place: 0, text: 'Site One' },
    { p: 2, day: '2026-01-05', kind: 'place', place: 0, text: 'Site One' },
    { p: 0, day: '2026-01-08', kind: 'place', place: 0, text: 'Site One' },
    { p: 0, day: '2026-01-09', kind: 'place', place: 0, text: 'Site One' },
    { p: 0, day: '2026-01-12', kind: 'place', place: 0, text: 'Site One' },
  ];
  const personFor = [{ employeeId: 'e1' }, null, { employeeId: 'e1' }];
  const placeFor = [{ contractId: 'c1' }, null];

  it('plans one record per person per day and says why the rest are left', () => {
    const { records, skipped } = planAttendance({
      cells, personFor, placeFor, today: '2026-01-10',
      taken: new Set(['e:e1|2026-01-08']), lockedDays: new Set(['2026-01-09']),
    });
    assert.deepEqual(records.map((r) => [r.day, r.type]), [['2026-01-05', 'work'], ['2026-01-06', 'off']]);
    assert.deepEqual(records[0].target, { contractId: 'c1' });
    assert.deepEqual(skipped, { person: 1, place: 1, existing: 1, locked: 1, future: 1, duplicate: 1 });
  });
});

// ── Running the imports, with the database replaced by fakes ────────────

const query = (rows) => {
  const q = { select: () => q, sort: () => q, lean: () => q, populate: () => q, then: (ok, bad) => Promise.resolve(rows).then(ok, bad) };
  return q;
};

describe('Running the imports', () => {
  let saved; let staged; let inserted; let created; let locations;
  const E1 = 'e'.repeat(24);
  const C1 = 'c'.repeat(24);
  const P1 = 'f'.repeat(24);

  const workbookImport = {
    create: async (doc) => { staged = { ...doc, uuid: 'u1', _id: 'w1' }; return staged; },
    findOne: () => query(staged),
    updateOne: async (_q, u) => { Object.assign(staged, u.$set); },
  };

  before(() => {
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST };
    mdb.INTERNAL = {
      workbookImport,
      employee: { find: () => query([{ _id: E1, name: 'Alex Smith', status: 'active', contract: { hoursPerWeek: 40, workingDaysPerWeek: 5 } }]) },
      contract: { find: () => query([{ _id: C1, title: 'Site One', status: 'In Progress', projectId: P1 }]) },
      location: {
        find: () => query(locations),
        create: async (doc) => { const l = { _id: 'b'.repeat(23) + locations.length, ...doc }; locations.push(l); created.push(l); return l; },
      },
      attendance: {
        find: () => query([{ employeeId: E1, date: new Date(2026, 0, 7) }]),
        insertMany: async (docs) => { inserted.push(...docs); return docs; },
      },
      payrollRun: { findOne: () => query(null) },
      jobRegister: {
        find: () => query([{ _id: 'r1', projectNumber: 41010, site: '1 Test St', client: 'Example Homes' }]),
        create: async (doc) => { created.push(doc); return doc; },
        findById: async () => ({ set(f) { this.fields = f; }, async save() { created.push({ updated: this.fields }); } }),
      },
    };
    mdb.REST = { supplier: { find: () => query([]) } };
  });
  after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; });

  it('imports the weekly sheet as pending records with the sheet text in the notes', async () => {
    inserted = []; created = []; locations = [{ _id: 'a'.repeat(24), name: 'Office' }];
    await sheetImport.stageUpload({
      sheets: [weekTab('11 JAN 26', '2026-01-05', [['ALEX', 'Site One', 'Office', 'Site One', 'New Place', 'OFF', null], ['Visitor', 'Site One']])],
      fileName: 'test.xlsx',
    });
    const mapping = await sheetImport.loadMapping('u1');
    const alex = mapping.people.find((p) => p.label === 'ALEX');
    assert.equal(alex.suggestion, `e:${E1}`);
    const body = {};
    for (const p of mapping.people) body[`person_${p.index}`] = p.suggestion;
    for (const p of mapping.places) body[`place_${p.index}`] = p.suggestion;
    assert.equal(body[`place_${mapping.places.find((p) => p.label === 'Site One').index}`], `con:${C1}`);

    const r = await sheetImport.runImport('u1', body, { today: '2026-01-31' });
    assert.equal(r.created, 4); // Mon, Tue, Thu, Fri; Wed already has a record
    assert.equal(r.skipped.existing, 1);
    assert.equal(r.skipped.person, 1); // "Visitor" matched no one
    assert.equal(r.createdLocations, 1);
    assert.equal(created[0].name, 'New Place');
    const mon = inserted.find((d) => d.date.getDate() === 5);
    assert.equal(mon.status, 'pending');
    assert.equal(mon.type, 'work');
    assert.equal(String(mon.contractId), C1);
    assert.equal(String(mon.projectId), P1);
    assert.equal(mon.hoursWorked.toString(), '8');
    assert.match(mon.notes, /Imported from the weekly sheet: "Site One"/);
    assert.equal(inserted.find((d) => d.date.getDate() === 9).type, 'off');
    assert.ok(staged.importedAt);
    await assert.rejects(sheetImport.runImport('u1', body), /already been imported/);
  });

  it('imports the Job Reg: new rows created, an existing job filled in', async () => {
    created = [];
    await jobImport.stageUpload({
      sheets: [
        { name: 'Quotes 26', rows: [quoteRow(50010, '1 Test St', 'Example Homes', 1000), quoteRow(50011, '2 Test St', 'Example Homes', 300)] },
        { name: 'Job Reg 26', rows: [jobRow(41010, '1 Test St', 'Example Homes', 1000)] },
      ],
      fileName: 'jobreg.xlsx',
    });
    const preview = await jobImport.loadPreview('u1');
    assert.deepEqual(preview.counts, { create: 1, update: 1, same: 0, conflict: 0 });
    const r = await jobImport.runImport('u1', []);
    assert.equal(r.created, 1);
    assert.equal(r.updated, 1);
    assert.equal(created.find((c) => c.quoteNumber === 50011).quoteDate.toISOString(), '2026-01-10T12:00:00.000Z');
    assert.equal(created.find((c) => c.updated).updated.quoteNumber, 50010);
  });
});

// ── Pages ───────────────────────────────────────────────────────────────

describe('Import pages', () => {
  const view = (name) => path.join(root, 'mongoose/views/tailwindcss/import', name);

  it('draws the upload page as a multipart form with CSRF', async () => {
    const html = await ejs.renderFile(view('upload.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], action: '/job-register/import', heading: 'Import', icon: 'bi-journal-text', intro: 'x', points: ['a', 'b'],
    });
    assert.match(html, /enctype="multipart\/form-data"/);
    assert.match(html, /name="workbook"/);
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script/);
  });

  it('draws the Job Reg check page with the suggested pairs ticked', async () => {
    const p = parseJobRegWorkbook([
      { name: 'Quotes 26', rows: [quoteRow(50010, '1 Test St', 'Example Homes', 1000)] },
      { name: 'Job Reg 26', rows: [jobRow(41010, '1 Test St', 'Example Homes', 1100)] },
    ]);
    const suggestions = jobImport.tickedPairs({ parsed: p });
    const plan = planImport(p.entries, []);
    const html = await ejs.renderFile(view('job-register.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], staged: { uuid: 'u1', fileName: 'f.xlsx', parsed: p }, plan, suggestions, counts: summarisePlan(plan),
    });
    assert.match(html, /name="pair" value="50010:41010"[^>]*checked/);
    assert.match(html, /action="\/job-register\/import\/u1"/);
    assert.match(html, /formaction="\/job-register\/import\/u1\/save"/);
    assert.match(html, /action="\/job-register\/import\/u1\/delete"/);
    assert.match(html, /1 Test St/);
    assert.doesNotMatch(html, /<script/);
  });

  it('draws the weekly sheet mapping with a select per name and site', async () => {
    const parsed = parseAttendanceWorkbook([weekTab('11 JAN 26', '2026-01-05', [['ALEX', 'Site One', 'Office']])]);
    const html = await ejs.renderFile(view('weekly-sheet.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], staged: { uuid: 'u2', fileName: 'w.xlsx', parsed },
      choices: { employees: [{ _id: 'e1', name: 'Alex Smith', status: 'active' }], subcontractors: [], contracts: [{ _id: 'c1', title: 'Site One', status: 'In Progress' }], locations: [{ _id: 'l1', name: 'Office' }] },
      people: parsed.people.map((x, index) => ({ ...x, index, suggestion: 'e:e1' })),
      places: parsed.places.map((x, index) => ({ ...x, index, suggestion: x.label === 'Office' ? 'loc:l1' : 'new' })),
    });
    assert.match(html, /name="person_0"/);
    assert.match(html, /<option value="e:e1" selected>Alex Smith/);
    assert.match(html, /name="place_1"/);
    assert.match(html, /<option value="loc:l1" selected>Office/);
    assert.match(html, /action="\/weekly-sheet\/import\/u2"/);
    assert.match(html, /formaction="\/weekly-sheet\/import\/u2\/save"/);
    assert.match(html, /action="\/weekly-sheet\/import\/u2\/delete"/);
    assert.doesNotMatch(html, /<script/);
  });
});

describe('Import buttons', () => {
  // The layout gives views `isAdmin` (app.js), not `user`, so the button must key off that
  it('show on the Job Register and weekly sheet for admins only', async () => {
    const fs = await import('node:fs');
    for (const [file, href] of [['jobRegister/index.ejs', '/job-register/import'], ['attendance/weekly-sheet.ejs', '/weekly-sheet/import']]) {
      const src = fs.readFileSync(path.join(root, 'mongoose/views/tailwindcss', file), 'utf8');
      const at = src.indexOf(`href="${href}"`);
      assert.ok(at > 0, `${file} links to ${href}`);
      assert.match(src.slice(Math.max(0, at - 200), at), /typeof isAdmin !== 'undefined' && isAdmin/);
    }
  });
});

describe('Saved and recent uploads', () => {
  let store; let saved; let lastQuery; let docs; let updates;
  const NOW = new Date('2026-11-16T12:00:00Z');
  before(async () => {
    store = (await import('../mongoose/services/workbookImportStore.js')).default;
    saved = mdb.INTERNAL;
    const q = (rows) => { const o = { select: () => o, populate: () => o, sort: () => o, limit: () => o, lean: async () => rows() }; return o; };
    mdb.INTERNAL = {
      workbookImport: {
        find: (filter) => { lastQuery = filter; return q(() => docs); },
        findOne: (f) => q(() => docs.find((d) => d.uuid === f.uuid && d.kind === f.kind) || null),
        updateOne: async (f, u) => { updates.push({ f, u }); },
        deleteOne: async (f) => ({ deletedCount: docs.some((d) => d.uuid === f.uuid && d.kind === f.kind) ? 1 : 0 }),
      },
    };
  });
  after(() => { mdb.INTERNAL = saved; });

  it('asks for saved uploads not yet imported, plus any not expired', async () => {
    docs = [
      { uuid: 'u3', kind: 'weeklySheet', fileName: 'kept.xlsx', createdAt: new Date('2026-11-10T09:00:00Z'), saved: true, savedAt: new Date('2026-11-10T10:00:00Z') },
      { uuid: 'u2', kind: 'weeklySheet', fileName: 'week.xlsx', createdAt: new Date('2026-11-16T09:00:00Z'), expiresAt: new Date('2026-11-17T09:00:00Z'), createdBy: { username: 'admin1' } },
      { uuid: 'u1', kind: 'weeklySheet', fileName: 'done.xlsx', createdAt: new Date('2026-11-16T08:00:00Z'), expiresAt: new Date('2026-11-17T08:05:00Z'), importedAt: new Date('2026-11-16T08:05:00Z'), result: { created: 12, createdLocations: 1 } },
    ];
    const list = await store.recentUploads('weeklySheet', NOW);
    assert.equal(lastQuery.kind, 'weeklySheet');
    assert.deepEqual(lastQuery.$or[0], { saved: true, importedAt: null });
    assert.equal(lastQuery.$or[1].expiresAt.$gt, NOW);
    assert.deepEqual(list.map((u) => [u.uuid, u.saved]), [['u3', true], ['u2', false], ['u1', false]]);
    assert.equal(list[1].by, 'admin1');
    assert.equal(list[2].summary, '12 days imported, 1 new location');
    assert.equal(store.describeUpload({ uuid: 'x', importedAt: new Date(), result: { created: 5, updated: 1 } }, 'jobRegister').summary, '5 rows added, 1 row filled in');
  });

  it('lists saved, waiting and imported uploads on the upload page, each with a delete button', async () => {
    const uploads = await store.recentUploads('weeklySheet', NOW);
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/import/upload.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], action: '/weekly-sheet/import', heading: 'h', icon: 'bi-x', intro: 'i', points: [], uploads,
    });
    assert.match(html, /href="\/weekly-sheet\/import\/u3"[^>]*>Carry on/);
    assert.match(html, /href="\/weekly-sheet\/import\/u2"[^>]*>Check and import/);
    assert.match(html, /href="\/weekly-sheet\/import\/u1"[^>]*>View/);
    assert.match(html, /Kept until imported or deleted/);
    assert.match(html, /action="\/weekly-sheet\/import\/u2\/delete"/);
    const empty = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/import/upload.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], action: '/x', heading: 'h', icon: 'bi-x', intro: 'i', points: [], uploads: [],
    });
    assert.match(empty, /No uploads waiting/);
  });

  it('treats an unsaved upload past its expiry as gone, and a saved one as kept', async () => {
    docs = [
      { uuid: 'old', kind: 'jobRegister', expiresAt: new Date('2026-11-16T11:00:00Z'), parsed: {} },
      { uuid: 'kept', kind: 'jobRegister', saved: true, parsed: {} },
    ];
    await assert.rejects(store.findUpload('old', 'jobRegister', NOW), (e) => e.status === 404);
    assert.equal((await store.findUpload('kept', 'jobRegister', NOW)).uuid, 'kept');
    await assert.rejects(store.findUpload('kept', 'weeklySheet', NOW), (e) => e.status === 404);
  });

  it('saving keeps the choices and clears the expiry; importing sets it again', async () => {
    docs = [{ _id: 'd1', uuid: 'u9', kind: 'weeklySheet', expiresAt: new Date('2026-11-17T00:00:00Z'), parsed: {} }];
    updates = [];
    await store.saveChoices('u9', 'weeklySheet', { person: { 0: 'e:x' } }, 'admin');
    assert.equal(updates[0].u.$set.saved, true);
    assert.deepEqual(updates[0].u.$set.choices, { person: { 0: 'e:x' } });
    assert.deepEqual(updates[0].u.$unset, { expiresAt: 1 });
    await store.markImported('d1', { created: 1 }, NOW);
    assert.equal(updates[1].u.$set.saved, false);
    assert.equal(updates[1].u.$set.expiresAt.toISOString(), '2026-11-17T12:00:00.000Z');
    docs[0].importedAt = NOW;
    await assert.rejects(store.saveChoices('u9', 'weeklySheet', {}, 'admin'), /already been imported/);
  });

  it('deletes an upload, or says it is gone', async () => {
    docs = [{ uuid: 'u5', kind: 'jobRegister' }];
    await store.deleteUpload('u5', 'jobRegister');
    await assert.rejects(store.deleteUpload('nope', 'jobRegister'), (e) => e.status === 404);
  });
});

describe('Saved choices', () => {
  it('weekly sheet: keeps only well-formed matches, blank meaning skip', () => {
    const id = 'a'.repeat(24);
    const c = sheetImport.readChoices(
      { person_0: `e:${id}`, person_1: '', person_2: 'junk', place_0: 'new', place_1: `con:${id}`, place_2: 'con:bad' },
      { people: [{}, {}, {}], places: [{}, {}, {}] },
    );
    assert.deepEqual(c, { person: { 0: `e:${id}`, 1: '' }, place: { 0: 'new', 1: `con:${id}` } });
  });

  it('Job Reg: ticks the saved pairs instead of the likely ones', () => {
    const parsed = { suggestions: [{ quoteNumber: 1, projectNumber: 10, likely: true }, { quoteNumber: 2, projectNumber: 20, likely: false }] };
    assert.deepEqual(jobImport.tickedPairs({ parsed }).map((s) => s.ticked), [true, false]);
    assert.deepEqual(jobImport.tickedPairs({ parsed, saved: true, choices: { pairs: ['2:20'] } }).map((s) => s.ticked), [false, true]);
  });
});
