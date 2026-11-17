// Workbook imports: the Job Reg and weekly attendance spreadsheets.
// All names, sites and numbers here are invented.
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import ExcelJS from 'exceljs';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import notifyService from '../services/notifyService.js';
import { readWorkbook, flattenValue, dayOf, isXlsxUpload, fillColour, colourName, themePalette } from '../mongoose/services/xlsxReaderService.js';
import jobImport, {
  cellText, cellInt, cellMoney, cellDate, siteKey, parseRow, pairQuotesWithJobs, parseJobRegWorkbook,
  planImport, summarisePlan, toModelFields, applyChosenPairs, suggestPairs, rowColour, colourState, mergePair,
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

  it('names fill colours, theme colours with their tint included', () => {
    const solid = (fgColor) => ({ type: 'pattern', pattern: 'solid', fgColor });
    assert.equal(fillColour(solid({ argb: 'FFFFFF00' })), 'yellow');
    assert.equal(fillColour(solid({ argb: 'FF92D050' })), 'green');
    assert.equal(fillColour(solid({ argb: 'FFFF0000' })), 'red');
    assert.equal(fillColour(solid({ theme: 5 })), 'orange');
    assert.equal(fillColour(solid({ theme: 2, tint: -0.4999 })), 'grey');
    assert.equal(fillColour(solid({ theme: 2, tint: -0.7499 })), 'black');
    assert.equal(fillColour(solid({ theme: 0 })), 'white');
    assert.equal(fillColour({ type: 'pattern', pattern: 'none' }), null);
    assert.equal(fillColour(undefined), null);
    assert.equal(colourName([0, 112, 192]), 'blue');
    // The workbook's own theme wins over Office's
    const palette = themePalette('<a:accent2><a:srgbClr val="00B050"/></a:accent2>');
    assert.equal(fillColour(solid({ theme: 5 }), palette), 'green');
  });

  it('gives each cell its fill colour alongside its value', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Job Reg 26');
    ws.getCell('A2').value = 41001;
    ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFED7D31' } };
    ws.getCell('C2').value = '1 Test Street';
    ws.getCell('C2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
    ws.getCell('D2').value = 'Example Homes';
    const [sheet] = await readWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(sheet.fills[1][0], 'orange');
    assert.equal(sheet.fills[1][2], 'green');
    assert.equal(sheet.fills[1][3], null);
    assert.deepEqual(sheet.fills[0], []);
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

// A row's fills: every column from B the same colour
const filled = (colour, n = 12) => Array.from({ length: n }, (_, i) => (i === 0 ? null : colour));

describe('Job Reg colours', () => {
  it("takes a row's colour from most of its cells", () => {
    assert.equal(rowColour([null, 'yellow', 'yellow', 'red', null], [1, 2, 3, 4]), 'yellow');
    assert.equal(rowColour([], [1, 2, 3]), 'none');
  });

  it('reads the Quotes colours as to quote, quoted and won', () => {
    assert.deepEqual(colourState('quote', 'none'), { quoteStatus: 'toQuote' });
    assert.deepEqual(colourState('quote', 'white'), { quoteStatus: 'toQuote' });
    assert.deepEqual(colourState('quote', 'grey'), { quoteStatus: 'quoted' });
    assert.deepEqual(colourState('quote', 'black'), { quoteStatus: 'quoted' });
    assert.deepEqual(colourState('quote', 'yellow'), { quoteStatus: 'quoted', won: true });
    assert.deepEqual(colourState('quote', 'red'), { note: 'Marked red on the Quotes sheet' });
  });

  it('reads the Job Reg colours as live, completed and in KashFlow', () => {
    assert.deepEqual(colourState('job', 'yellow'), {});
    assert.deepEqual(colourState('job', 'yellow', 'orange'), { inKashflow: true });
    assert.deepEqual(colourState('job', 'green', 'orange'), { completed: true, inKashflow: true });
    assert.deepEqual(colourState('job', 'red', 'orange'), { note: 'Marked red on the Job Reg sheet', inKashflow: true });
  });

  it('puts the colours on the parsed rows and keeps them when a quote and job pair', () => {
    const q = parseRow(quoteRow(50010, '10 Test St', 'Example Homes', 900), 'quote', 3, filled('yellow'));
    assert.equal(q.colour, 'yellow');
    assert.equal(q.won, true);
    assert.equal(q.quoteStatus, 'quoted');
    const grey = parseRow(quoteRow(50011, '11 Test St', 'Example Homes', 900), 'quote', 4, filled('grey'));
    assert.equal(grey.quoteStatus, 'quoted');
    assert.equal(grey.won, undefined);
    const white = parseRow(quoteRow(50012, '12 Test St', 'Example Homes', 900), 'quote', 5);
    assert.equal(white.quoteStatus, 'toQuote');
    const fills = filled('green');
    fills[0] = 'orange';
    const j = parseRow(jobRow(41010, '10 Test St', 'Example Homes', 900), 'job', 6, fills);
    assert.equal(j.completed, true);
    assert.equal(j.inKashflow, true);
    const pair = mergePair(q, j);
    assert.equal(pair.won, true);
    assert.equal(pair.completed, true);
    assert.equal(pair.inKashflow, true);
    assert.equal(pair.quoteStatus, 'quoted');
  });

  it('moves a register row on by its colours, and only takes one off a row it may overwrite', () => {
    const entry = { quoteNumber: 50020, site: '20 Test St', client: 'Example Homes', quoteStatus: 'quoted', won: true };
    const edited = { _id: 'r1', quoteNumber: 50020, site: '20 Test St', client: 'Example Homes', quoteStatus: 'toQuote', editedAt: new Date() };
    const [p] = planImport([entry], [edited]);
    assert.equal(p.action, 'update');
    assert.deepEqual(p.fill, { quoteStatus: 'quoted', won: true });

    const imported = { _id: 'r2', quoteNumber: 50021, site: '21 Test St', client: 'Example Homes', quoteStatus: 'quoted', won: true, importId: 'u1' };
    const [p2] = planImport([{ quoteNumber: 50021, site: '21 Test St', client: 'Example Homes', quoteStatus: 'quoted' }], [imported]);
    assert.deepEqual(p2.fill, { won: false });
    const [p3] = planImport([{ quoteNumber: 50021, site: '21 Test St', client: 'Example Homes', quoteStatus: 'quoted' }], [{ ...imported, editedAt: new Date() }]);
    assert.equal(p3.action, 'same');

    assert.deepEqual(toModelFields({ won: true, completed: false, inKashflow: true, quoteStatus: 'quoted' }), { won: true, inKashflow: true, quoteStatus: 'quoted' });
  });

  it('leaves a row paired by hand alone when the same quote and job come in unpaired', () => {
    // Imported last time as one row from a ticked pair, not edited since
    const row = {
      _id: 'r1', quoteNumber: 50040, projectNumber: 41040, site: '40 Test St', client: 'Example Homes', value: 1000,
      quoteStatus: 'quoted', won: true, completed: true, inKashflow: true, importId: 'u1',
    };
    const quote = { kind: 'quote', quoteNumber: 50040, site: '40 Test St', client: 'Example Homes', value: 900, quoteStatus: 'quoted', won: true };
    const job = { kind: 'job', projectNumber: 41040, site: '40 Test St', client: 'Example Homes', value: 1000, completed: true, inKashflow: true };
    assert.deepEqual(planImport([quote, job], [row]).map((p) => p.action), ['same', 'same']);
    // A job's colour taken off still counts; a quote can't take a job's flags off
    const [p] = planImport([{ ...job, completed: false }], [row]);
    assert.deepEqual(p.fill, { completed: false });
    const [q] = planImport([{ ...quote, won: false }], [{ ...row, projectNumber: null }]);
    assert.deepEqual(q.fill, { value: 900, won: false });
  });

  it("shows each row's colour and the stage it gives on the import preview", async () => {
    const e = { kind: 'quote', quoteNumber: 50030, quoteDate: '2026-01-10', site: '30 Test St', client: 'Example Homes', value: 100, colour: 'yellow', quoteStatus: 'quoted', won: true, notes: '' };
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/import/job-register.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], fromKashflow: 0,
      staged: { uuid: 'u1', fileName: 'Job Reg.xlsx', parsed: { sheets: {}, entries: [e], suggestions: [], problems: [], counts: { quotes: 1, jobs: 0, pairs: 0, ambiguous: 0 } } },
      plan: [{ action: 'create', entry: e, stage: 'won' }], suggestions: [], clients: [], customers: [],
      counts: { create: 1, update: 0, same: 0, conflict: 0, skip: 0 },
    });
    assert.match(html, /Sheet colour/);
    assert.match(html, /yellow → Won/);
  });
});

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
    assert.deepEqual(summarisePlan(plan), { create: 1, update: 1, same: 1, conflict: 0, skip: 0 });
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

  it('suggests a location by name, else a job by number or site, else skip', () => {
    const locations = [{ _id: 'l1', name: 'Office' }, { _id: 'l2', name: 'Garston Office' }];
    const jobs = [
      { _id: 'j1', projectNumber: 41250, site: '27 Test Square, Townville' },
      { _id: 'j2', projectNumber: 41251, site: 'Oak Court' },
      { _id: 'j3', projectNumber: 41252, site: 'Oak Court, Phase 2' }, // same site before the comma as j2
      { _id: 'j4', projectNumber: 41253, site: 'St. Mary\'s Church' },
    ];
    assert.equal(suggestPlace('office', { locations, jobs }), 'loc:l1');
    assert.equal(suggestPlace('GARSTON  OFFICE', { locations, jobs }), 'loc:l2');
    assert.equal(suggestPlace('41250', { locations, jobs }), 'job:j1');
    assert.equal(suggestPlace('Oak Court 41252', { locations, jobs }), 'job:j3'); // the number wins over the site
    assert.equal(suggestPlace('27 test square', { locations, jobs }), 'job:j1'); // the site up to its comma
    assert.equal(suggestPlace('St Marys Church', { locations, jobs }), 'job:j4'); // punctuation doesn't count
    assert.equal(suggestPlace('st. mary’s church!', { locations, jobs }), 'job:j4');
    assert.equal(suggestPlace('Oak Court', { locations, jobs }), ''); // two jobs: don't guess
    assert.equal(suggestPlace('27 Test', { locations, jobs }), '');
    assert.equal(suggestPlace('Elsewhere', { locations, jobs }), '');
  });

  it('reads the submitted choices strictly', () => {
    const id = 'a'.repeat(24);
    assert.deepEqual(readPersonChoice(`e:${id}`), { employeeId: id });
    assert.deepEqual(readPersonChoice(`s:${id}`), { subcontractorId: id });
    assert.equal(readPersonChoice('e:nope'), null);
    assert.deepEqual(readPlaceChoice(`job:${id}`), { jobRegisterId: id });
    assert.deepEqual(readPlaceChoice(`loc:${id}`), { locationId: id });
    // From older uploads: a contract or a new location is no longer a choice
    assert.equal(readPlaceChoice(`con:${id}`), null);
    assert.equal(readPlaceChoice('new'), null);
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
  const J1 = 'd'.repeat(24);

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
        find: () => query([{ _id: J1, projectNumber: 41010, site: '1 Test St', client: 'Example Homes', contractId: C1 }]),
        create: async (doc) => { created.push(doc); return doc; },
        findById: async () => ({ set(f) { this.fields = f; }, async save() { created.push({ updated: this.fields }); } }),
      },
    };
    mdb.REST = { supplier: { find: () => query([]) }, customer: { find: () => query([{ Code: 'EX1', Name: 'Example Homes Ltd' }]) }, project: { find: () => query([]) } };
  });
  after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; });

  it('imports the weekly sheet as pending records with the sheet text in the notes', async () => {
    inserted = []; created = []; locations = [{ _id: 'a'.repeat(24), name: 'Office' }];
    await sheetImport.stageUpload({
      sheets: [weekTab('11 JAN 26', '2026-01-05', [['ALEX', '1 TEST ST', 'Office', '1 Test St', 'New Place', 'OFF', null], ['Visitor', '1 Test St']])],
      fileName: 'test.xlsx',
    });
    const mapping = await sheetImport.loadMapping('u1');
    const alex = mapping.people.find((p) => p.label === 'ALEX');
    assert.equal(alex.suggestion, `e:${E1}`);
    assert.deepEqual(mapping.choices.jobs.map((j) => j.label), ['41010 1 Test St (Example Homes)']);
    assert.equal(mapping.places.find((p) => p.label === 'New Place').suggestion, ''); // no new location: skip
    const body = {};
    for (const p of mapping.people) body[`person_${p.index}`] = p.suggestion;
    for (const p of mapping.places) body[`place_${p.index}`] = p.suggestion;
    assert.equal(body[`place_${mapping.places.find((p) => p.key === '1 test st').index}`], `job:${J1}`);

    // Alex is told once about the days written; the admin who ran it is not
    const told = [];
    mock.method(notifyService, 'notifyUsers', async (args) => { told.push(args); return { recipients: args.users.length }; });
    mdb.INTERNAL.user = {
      find: () => query([{ _id: 'ua', employeeId: E1 }, { _id: 'admin', employeeId: E1 }]),
    };
    const r = await sheetImport.runImport('u1', body, { today: '2026-01-31', actorId: 'admin' });
    mock.restoreAll();
    delete mdb.INTERNAL.user;
    assert.equal(told.length, 1);
    assert.deepEqual(told[0].users.map((u) => u._id), ['ua']);
    assert.equal(told[0].type, 'attendance');
    assert.match(told[0].text, /Mon 5 Jan: 41010 1 Test St \(Example Homes\)\nTue 6 Jan: Office\nFri 9 Jan: Off/);
    assert.match(told[0].dedupeKey, new RegExp(`^attendance:import:u1:[0-9a-f]{16}:e:${E1}$`));
    assert.equal(r.created, 3); // Mon, Tue, Fri; Wed already has a record, Thu's site is skipped
    assert.equal(r.skipped.existing, 1);
    assert.equal(r.skipped.place, 1);
    assert.equal(r.skipped.person, 1); // "Visitor" matched no one
    assert.equal('createdLocations' in r, false);
    assert.equal(created.length, 0, 'no location made');
    assert.equal(locations.length, 1);
    const mon = inserted.find((d) => d.date.getDate() === 5);
    assert.equal(mon.status, 'pending');
    assert.equal(mon.type, 'work');
    // The job, its contract, and the contract's project (no synced project has 41010)
    assert.equal(String(mon.jobRegisterId), J1);
    assert.equal(String(mon.contractId), C1);
    assert.equal(String(mon.projectId), P1);
    assert.equal(mon.hoursWorked.toString(), '8');
    assert.match(mon.notes, /Imported from the weekly sheet: "1 TEST ST"/);
    assert.equal(inserted.find((d) => d.date.getDate() === 9).type, 'off');
    assert.ok(staged.importedAt);
    await assert.rejects(sheetImport.runImport('u1', body), /already been imported/);
  });

  it('shows an older upload saved with a contract or "new location" with today\'s suggestions instead', async () => {
    locations = [{ _id: 'a'.repeat(24), name: 'Office' }];
    await sheetImport.stageUpload({
      sheets: [weekTab('11 JAN 26', '2026-01-05', [['ALEX', '1 Test St', 'Office', 'New Place']])],
      fileName: 'old.xlsx',
    });
    const at = (label) => staged.parsed.places.findIndex((p) => p.label === label);
    Object.assign(staged, { saved: true, choices: { person: {}, place: { [at('1 Test St')]: `con:${C1}`, [at('New Place')]: 'new', [at('Office')]: '' } } });
    const mapping = await sheetImport.loadMapping('u1');
    const suggestion = (label) => mapping.places.find((p) => p.label === label).suggestion;
    assert.equal(suggestion('1 Test St'), `job:${J1}`);
    assert.equal(suggestion('New Place'), '');
    assert.equal(suggestion('Office'), '', 'a saved Skip is kept');
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
    assert.deepEqual(preview.counts, { create: 1, update: 1, same: 0, conflict: 0, skip: 0 });
    assert.deepEqual(preview.clients.map((c) => [c.label, c.code]), [['Example Homes', 'EX1']]); // suggested by name
    const r = await jobImport.runImport('u1', {});
    assert.equal(r.created, 1);
    assert.equal(r.updated, 1);
    const q = created.find((c) => c.quoteNumber === 50011);
    assert.equal(q.quoteDate.toISOString(), '2026-01-10T12:00:00.000Z');
    assert.equal(q.customerCode, 'EX1');
    assert.equal(q.client, 'Example Homes Ltd'); // the KashFlow name
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
    const customers = [{ code: 'EX1', name: 'Example Homes Ltd' }];
    const clients = jobImport.clientMapping({ parsed: p }, customers);
    const html = await ejs.renderFile(view('job-register.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], staged: { uuid: 'u1', fileName: 'f.xlsx', parsed: p }, plan, suggestions, counts: summarisePlan(plan), clients, customers,
    });
    assert.match(html, /name="client_0"/);
    assert.match(html, /<option value="EX1" selected>Example Homes Ltd \(EX1\)/);
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
      choices: { employees: [{ _id: 'e1', name: 'Alex Smith', status: 'active' }], subcontractors: [], jobs: [{ _id: 'j1', label: '41010 Site One (Example Homes)' }], locations: [{ _id: 'l1', name: 'Office' }] },
      people: parsed.people.map((x, index) => ({ ...x, index, suggestion: 'e:e1' })),
      places: parsed.places.map((x, index) => ({ ...x, index, suggestion: x.label === 'Office' ? 'loc:l1' : 'job:j1' })),
    });
    assert.match(html, /name="person_0"/);
    assert.match(html, /<option value="e:e1" selected>Alex Smith/);
    assert.match(html, /name="place_1"/);
    assert.match(html, /<option value="loc:l1" selected>Office/);
    assert.match(html, /<optgroup label="Jobs">\s*<option value="job:j1" selected>41010 Site One \(Example Homes\)<\/option>/);
    assert.doesNotMatch(html, /New location|value="new"|value="con:/);
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
      assert.match(src.slice(Math.max(0, at - 500), at), /typeof isAdmin !== 'undefined' && isAdmin/);
    }
  });

  it('keeps the weekly sheet import away from the week buttons', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(path.join(root, 'mongoose/views/tailwindcss/attendance/weekly-sheet.ejs'), 'utf8');
    assert.ok(src.indexOf('href="/weekly-sheet/import"') > src.indexOf('Vehicles'), 'import link sits at the bottom, after the side panels');
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
    // saveChoices checks the expiry against the real clock, so expire a day from now
    docs = [{ _id: 'd1', uuid: 'u9', kind: 'weeklySheet', expiresAt: new Date(Date.now() + 864e5), parsed: {} }];
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
      { person_0: `e:${id}`, person_1: '', person_2: 'junk', place_0: 'new', place_1: `con:${id}`, place_2: 'job:bad', place_3: `job:${id}`, place_4: `loc:${id}`, place_5: '' },
      { people: [{}, {}, {}], places: [{}, {}, {}, {}, {}, {}] },
    );
    assert.deepEqual(c, { person: { 0: `e:${id}`, 1: '' }, place: { 3: `job:${id}`, 4: `loc:${id}`, 5: '' } });
  });

  it('Job Reg: ticks the saved pairs instead of the likely ones', () => {
    const parsed = { suggestions: [{ quoteNumber: 1, projectNumber: 10, likely: true }, { quoteNumber: 2, projectNumber: 20, likely: false }] };
    assert.deepEqual(jobImport.tickedPairs({ parsed }).map((s) => s.ticked), [true, false]);
    assert.deepEqual(jobImport.tickedPairs({ parsed, saved: true, choices: { pairs: ['2:20'] } }).map((s) => s.ticked), [false, true]);
  });
});

describe('Job Reg clients as KashFlow customers', () => {
  const customers = [
    { code: 'PD1', name: 'Plus Example Housing' }, { code: 'KM1', name: 'Example Council' },
    { code: 'EX2', name: 'Example Homes' }, { code: 'EX3', name: 'Example Homes North' },
  ];

  it('lists the clients written on the sheets once each, with the usual spelling', () => {
    const list = jobImport.sheetClients([{ client: 'Plus Example' }, { client: 'plus example ' }, { client: 'Plus Example' }, { client: 'Example Council' }]);
    assert.deepEqual(list, [{ key: 'example council', label: 'Example Council', count: 1 }, { key: 'plus example', label: 'Plus Example', count: 3 }]);
  });

  it('suggests a customer by name, by a name it starts, or a name it is started by', () => {
    assert.equal(jobImport.suggestCustomer('example council', customers), 'KM1');
    assert.equal(jobImport.suggestCustomer('Plus Example', customers), 'PD1');
    assert.equal(jobImport.suggestCustomer('Example Council MAJ', customers), 'KM1');
    assert.equal(jobImport.suggestCustomer('Example Homes', customers), 'EX2'); // exact beats the longer one
    assert.equal(jobImport.suggestCustomer('Nobody Ltd', customers), '');
  });

  it('uses saved choices over suggestions, and only known customers', () => {
    const parsed = { entries: [{ client: 'Example Council' }, { client: 'Plus Example' }] };
    assert.deepEqual(jobImport.clientMapping({ parsed }, customers).map((c) => c.code), ['KM1', 'PD1']);
    const saved = { parsed, saved: true, choices: { clients: { 0: '', 1: 'XX9' } } };
    assert.deepEqual(jobImport.clientMapping(saved, customers).map((c) => c.code), ['', '']);
    assert.deepEqual(jobImport.readClientChoices({ client_0: 'KM1', client_1: 'bogus' }, [{}, {}, {}], customers), { 0: 'KM1', 1: '' });
  });

  it('sets each row to its customer, and leaves out rows whose client has none', () => {
    const entries = [{ kind: 'job', projectNumber: 1, client: 'Plus Example', site: 'A' }, { kind: 'job', projectNumber: 2, client: 'Nobody', site: 'B' }];
    const mapping = [{ key: 'plus example', code: 'PD1' }, { key: 'nobody', code: '' }];
    const out = jobImport.applyClients(entries, mapping, customers);
    assert.equal(out[0].customerCode, 'PD1');
    assert.equal(out[0].client, 'Plus Example Housing');
    assert.equal(out[1].unmatchedClient, true);
    const plan = planImport(out, []);
    assert.deepEqual(plan.map((x) => x.action), ['create', 'skip']);
    assert.equal(toModelFields(out[0]).customerCode, 'PD1');
  });
});

describe('Job Register client is a KashFlow customer', () => {
  let jr; let saved; let createdRows;
  before(async () => {
    jr = (await import('../mongoose/services/jobRegisterService.js')).default;
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST };
    const one = (row) => ({ select: () => ({ lean: async () => row }) });
    mdb.INTERNAL = { jobRegister: { create: async (f) => { createdRows.push(f); return { uuid: 'n1', ...f }; } } };
    mdb.REST = { customer: { findOne: (f) => one(f.Code === 'EX1' ? { Code: 'EX1', Name: 'Example Homes Ltd' } : null) } };
  });
  after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; });

  it('needs a known customer, and takes the client name from KashFlow', async () => {
    createdRows = [];
    await assert.rejects(jr.createEntry({ quoteNumber: '50001', site: 'A' }), (e) => e.status === 400 && /Choose the client/.test(e.message));
    await assert.rejects(jr.createEntry({ quoteNumber: '50001', site: 'A', customerCode: 'NOPE' }), (e) => e.status === 400);
    await jr.createEntry({ quoteNumber: '50001', site: 'A', customerCode: 'EX1', client: 'typed name' });
    assert.equal(createdRows[0].customerCode, 'EX1');
    assert.equal(createdRows[0].client, 'Example Homes Ltd');
  });

  it('checks KashFlow records by customer code when both have one', () => {
    const entry = { quoteNumber: 1, client: 'Example Homes Ltd', customerCode: 'EX1' };
    assert.equal(jr.matchEntry(entry, { quote: { CustomerCode: 'ex1', CustomerName: 'Renamed Ltd' } }).quote.state, 'ok');
    assert.equal(jr.matchEntry(entry, { quote: { CustomerCode: 'OTHER', CustomerName: 'Example Homes Ltd' } }).quote.state, 'differs');
    assert.equal(jr.matchEntry({ quoteNumber: 1, client: 'Example Homes Ltd' }, { quote: { CustomerName: 'example homes ltd' } }).quote.state, 'ok');
  });

  it('draws the form with a customer select, keeping an old typed client visible', async () => {
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/jobRegister/_fields.ejs'), {
      entry: { client: 'Old Typed Name' }, next: {}, clients: [], contracts: [], customers: [{ code: 'EX1', name: 'Example Homes Ltd' }],
      input: '', label: '', nextAction: '/x',
    });
    assert.match(html, /<select id="jr-customer" name="customerCode"/);
    assert.match(html, /was: Old Typed Name/);
    assert.match(html, /<option value="EX1" >Example Homes Ltd \(EX1\)/);
  });
});

describe('Re-importing over imported rows', () => {
  const entry = (over) => ({ kind: 'job', projectNumber: 41001, site: 'New Site', client: 'C', value: 200, notes: '', cancelled: false, ...over });

  it('updates an imported row nobody has edited, and only fills in one edited by hand', () => {
    const untouched = { _id: 'a', projectNumber: 41001, site: 'Old Site', client: 'C', value: 100, contact: 'Kept', importId: 'up1' };
    const edited = { ...untouched, editedAt: new Date() };
    const manual = { ...untouched, importId: undefined };
    const [u] = planImport([entry({ contact: '' })], [untouched]);
    assert.equal(u.action, 'update');
    assert.equal(u.overwrite, true);
    assert.deepEqual(u.fill, { site: 'New Site', value: 200 }); // a blank contact doesn't clear "Kept"
    assert.equal(planImport([entry()], [edited])[0].action, 'same');
    assert.equal(planImport([entry()], [manual])[0].action, 'same');
  });

  it('can un-cancel an untouched imported row the sheet no longer cancels', () => {
    const row = { _id: 'a', projectNumber: 41001, site: 'New Site', client: 'C', value: 200, cancelled: true, importId: 'up1' };
    assert.equal(planImport([entry()], [row])[0].fill.cancelled, false);
  });
});

describe('Marking and linking rows already imported', () => {
  let svc; let saved; let rows; let updates;
  before(async () => {
    svc = (await import('../mongoose/services/jobRegisterImportService.js')).default;
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST };
    const q = (fn) => { const o = { select: () => o, sort: () => o, lean: async () => fn() }; return o; };
    mdb.INTERNAL = {
      workbookImport: { find: () => q(() => [{ uuid: 'up1', importedAt: new Date('2026-11-16T03:00:00Z'), parsed: { entries: [{ projectNumber: 41001 }, { quoteNumber: 50001 }] } }]) },
      jobRegister: {
        find: (f) => q(() => rows.filter((r) => (f.importId ? !r.importId : true) && (f.customerCode ? !r.customerCode : true))),
        updateOne: async (f, u) => { updates.push({ f, u }); },
        updateMany: async (f, u) => { updates.push({ f, u }); return { modifiedCount: f._id.$in.length }; },
      },
    };
    mdb.REST = { customer: { find: () => q(() => [{ Code: 'EX1', Name: 'Example Homes Ltd' }]) } };
  });
  after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; });

  it('marks the rows an earlier upload created, treating ones changed since as edited', async () => {
    rows = [
      { _id: 'r1', createdAt: new Date('2026-11-16T02:59:00Z'), updatedAt: new Date('2026-11-16T02:59:00Z') },
      { _id: 'r2', createdAt: new Date('2026-11-16T02:59:30Z'), updatedAt: new Date('2026-11-16T03:20:00Z') },
    ];
    updates = [];
    assert.equal(await svc.flagImportedRows(), 2);
    assert.deepEqual(updates[0].u.$set, { importId: 'up1', importedAt: new Date('2026-11-16T03:00:00Z') });
    assert.equal(updates[1].u.$set.editedAt.toISOString(), '2026-11-16T03:20:00.000Z');
  });

  it('links every unlinked row of a client to the chosen customer', async () => {
    rows = [{ _id: 'a', client: 'Example Homes' }, { _id: 'b', client: 'example homes ' }, { _id: 'c', client: 'Other' }];
    updates = [];
    const page = await svc.loadUnlinked();
    assert.equal(page.total, 3);
    assert.deepEqual(page.clients.map((c) => [c.label, c.count, c.code]), [['Example Homes', 2, 'EX1'], ['Other', 1, '']]);
    const r = await svc.linkClients({ client_0: 'EX1', client_1: '' });
    assert.deepEqual(r, { rows: 2, clients: 1 });
    assert.deepEqual(updates[0].f._id.$in, ['a', 'b']);
    assert.deepEqual(updates[0].u.$set, { customerCode: 'EX1', client: 'Example Homes Ltd' });
  });
});

describe('Register by tax year', () => {
  it('draws a table per tax year, newest first, with the unlinked-clients banner', async () => {
    const jr = (await import('../mongoose/services/jobRegisterService.js')).default;
    const entries = [
      { uuid: 'a', quoteNumber: 1, site: 'A', client: 'C', value: 100, quoteDate: new Date('2025-05-01T12:00:00Z') },
      { uuid: 'b', quoteNumber: 2, site: 'B', client: 'C', value: 50, quoteDate: new Date('2026-05-01T12:00:00Z'), customerCode: 'X' },
    ];
    const data = jr.buildRegister({ entries, quotesByNumber: new Map(), projectsByNumber: new Map(), invoicesByNumber: new Map() });
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/jobRegister/index.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], ...data, unregistered: { year: 2026, quoteCount: 0, projectCount: 0, quotes: [], projects: [] },
      next: {}, stageLabels: jr.STAGE_LABELS, stages: jr.STAGES, contracts: [], customers: [], form: {}, unlinkedCount: 1, isAdmin: true,
    });
    const y26 = html.indexOf('Tax year 2026/27');
    const y25 = html.indexOf('Tax year 2025/26');
    assert.ok(y26 > 0 && y25 > y26, 'newest year first');
    assert.match(html, /href="#ty-2025"/);
    assert.match(html, /href="\/job-register\/link-clients"/);
  });
});

describe('Customer from the row\'s own KashFlow records', () => {
  const lookup = { projects: new Map([[41001, 'PR1']]), quotes: new Map([[50001, 'QU1'], [50002, 'QU2']]), invoices: new Map([[1700, 'IN1']]) };
  const customers = [{ code: 'PR1', name: 'Project Customer' }, { code: 'QU1', name: 'Quote Customer' }, { code: 'IN1', name: 'Invoice Customer' }];

  it('prefers the project, then the quote, then the invoice', () => {
    assert.deepEqual(jobImport.customerFromKashflow({ projectNumber: 41001, quoteNumber: 50001 }, lookup), { code: 'PR1', source: 'project' });
    assert.deepEqual(jobImport.customerFromKashflow({ projectNumber: 49999, quoteNumber: 50001 }, lookup), { code: 'QU1', source: 'quote' });
    assert.deepEqual(jobImport.customerFromKashflow({ invoiceNumber: 1700 }, lookup), { code: 'IN1', source: 'invoice' });
    assert.equal(jobImport.customerFromKashflow({ quoteNumber: 1 }, lookup), null);
  });

  it('sets the customer on rows found in KashFlow (known customers only) and leaves the rest for the mapping', () => {
    const out = jobImport.applyKashflowCustomers([
      { quoteNumber: 50001, client: 'typed' }, { quoteNumber: 50002, client: 'typed' }, { quoteNumber: 7, client: 'other' },
    ], lookup, customers);
    assert.equal(out[0].customerCode, 'QU1');
    assert.equal(out[0].client, 'Quote Customer');
    assert.equal(out[0].customerFrom, 'quote');
    assert.equal(out[1].customerCode, undefined); // QU2 isn't a known customer
    assert.deepEqual([...jobImport.clientsNeeded(out)], [['typed', 1], ['other', 1]]);
    const mapped = jobImport.applyClients(out, [{ key: 'typed', code: 'IN1' }, { key: 'other', code: '' }], customers);
    assert.equal(mapped[0].customerCode, 'QU1'); // KashFlow's customer wins over the mapping
    assert.equal(mapped[1].customerCode, 'IN1');
    assert.equal(mapped[2].unmatchedClient, true);
  });

  describe('linking and importing with a KashFlow database', () => {
    let saved; let rows; let updates; let createdRows;
    const q = (fn) => { const o = { select: () => o, sort: () => o, lean: async () => fn() }; return o; };
    before(() => {
      saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST };
      mdb.INTERNAL = {
        jobRegister: {
          find: () => q(() => rows),
          updateMany: async (f, u) => { updates.push({ f, u }); return { modifiedCount: f._id.$in.length }; },
          create: async (f) => { createdRows.push(f); return f; },
        },
      };
      mdb.REST = {
        customer: {
          find: () => q(() => [{ Code: 'PR1', Name: 'Project Customer' }, { Code: 'QU1', Name: 'Quote Customer' }]),
          findOne: (f) => q(() => ({ PR1: { Code: 'PR1', Name: 'Project Customer' }, QU1: { Code: 'QU1', Name: 'Quote Customer' } }[f.Code] || null)),
        },
        project: { find: () => q(() => [{ Number: 41001, CustomerCode: 'PR1' }]), findOne: (f) => q(() => (f.Number === 41001 ? { CustomerCode: 'PR1' } : null)) },
        quote: { find: () => q(() => [{ Number: 50001, CustomerCode: 'QU1' }]), findOne: (f) => q(() => (f.Number === 50001 ? { CustomerCode: 'QU1' } : null)) },
        invoice: { find: () => q(() => []), findOne: () => q(() => null) },
      };
    });
    after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; });

    it('the link page splits rows found in KashFlow from the rest, and links them by customer', async () => {
      rows = [
        { _id: 'a', client: 'Typed A', projectNumber: 41001 },
        { _id: 'b', client: 'Typed B', quoteNumber: 50001 },
        { _id: 'c', client: 'Typed C', quoteNumber: 9 },
      ];
      updates = [];
      const page = await jobImport.loadUnlinked();
      assert.deepEqual(page.fromKashflow.map((c) => [c.code, c.count]), [['PR1', 1], ['QU1', 1]]);
      assert.deepEqual(page.clients.map((c) => c.label), ['Typed C']);
      const r = await jobImport.linkFromKashflow();
      assert.deepEqual(r, { rows: 2, customers: 2 });
      assert.deepEqual(updates.map((u) => [u.f._id.$in, u.u.$set.customerCode, u.u.$set.client]), [[['a'], 'PR1', 'Project Customer'], [['b'], 'QU1', 'Quote Customer']]);
    });

    it('a form save with no customer picked takes the one on its KashFlow project or quote', async () => {
      const jr = (await import('../mongoose/services/jobRegisterService.js')).default;
      createdRows = [];
      await jr.createEntry({ quoteNumber: '50001', site: 'A' });
      assert.equal(createdRows[0].customerCode, 'QU1');
      assert.equal(createdRows[0].client, 'Quote Customer');
      await assert.rejects(jr.createEntry({ quoteNumber: '50009', site: 'A' }), /Choose the client/);
    });
  });
});

describe('Importing a weekly sheet again after failures', () => {
  it('is allowed only when an earlier import left days unsaved', () => {
    assert.equal(sheetImport.canImport({}), true);
    assert.equal(sheetImport.canImport({ importedAt: new Date(), result: { failed: 0 } }), false);
    assert.equal(sheetImport.canImport({ importedAt: new Date(), result: { failed: 754 } }), true);
  });

  it('records the matches used, and shows them again with the missing days on the page', async () => {
    const store = (await import('../mongoose/services/workbookImportStore.js')).default;
    const saved = mdb.INTERNAL;
    const updates = [];
    mdb.INTERNAL = { workbookImport: { updateOne: async (f, u) => { updates.push(u); } } };
    try {
      await store.markImported('d1', { created: 1, failed: 2 }, new Date('2026-11-16T03:49:00Z'), { choices: { person: { 0: 'e:x' } } });
    } finally { mdb.INTERNAL = saved; }
    assert.deepEqual(updates[0].$set.choices, { person: { 0: 'e:x' } });
    assert.equal(updates[0].$set.result.failed, 2);
    assert.equal(store.describeUpload({ uuid: 'x', importedAt: new Date(), result: { created: 5, failed: 2 } }, 'weeklySheet').summary, '5 days imported, 2 days not saved');

    const parsed = parseAttendanceWorkbook([weekTab('11 JAN 26', '2026-01-05', [['ALEX', 'Site One']])]);
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/import/weekly-sheet.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], canImport: true,
      staged: { uuid: 'u3', fileName: 'w.xlsx', parsed, importedAt: new Date(), result: { created: 1, failed: 2 } },
      choices: { employees: [], subcontractors: [], jobs: [], locations: [] },
      people: parsed.people.map((x, index) => ({ ...x, index, suggestion: '' })),
      places: parsed.places.map((x, index) => ({ ...x, index, suggestion: '' })),
    });
    assert.match(html, /couldn't be saved/);
    assert.match(html, /Import the missing days/);
    assert.doesNotMatch(html, /Save for later/);
  });
});
