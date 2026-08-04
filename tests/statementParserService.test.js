import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import statementImportModel from '../mongoose/models/mongoose/INTERNAL/statementImport.js';
import statementLineModel from '../mongoose/models/mongoose/INTERNAL/statementLine.js';
import {
  parseStatement,
  parseCsvStatement,
  parseOfxStatement,
  parseOcrStatement,
  parseCsv,
  validateBalanceChain,
  parseStatementDate,
  lineHash,
  toPence,
} from '../mongoose/services/statementParserService.js';

const ACCOUNT = 611594;

/* ── fixtures ─────────────────────────────────────────────────────── */

/** A consistent statement: opening 1000.00, three movements, closing 1150.36. */
const CSV_GOOD = `Date,Description,Paid Out,Paid In,Balance
03/08/2026,CARD PAYMENT TO SCREWFIX,16.46,,983.54
04/08/2026,BACS CREDIT PLUS DANE HOUSING,,250.00,1233.54
05/08/2026,DIRECT DEBIT NPOWER,83.18,,1150.36
`;

/** The same statement with one digit transposed in a balance. */
const CSV_CORRUPT = `Date,Description,Paid Out,Paid In,Balance
03/08/2026,CARD PAYMENT TO SCREWFIX,16.46,,983.54
04/08/2026,BACS CREDIT PLUS DANE HOUSING,,250.00,1223.54
05/08/2026,DIRECT DEBIT NPOWER,83.18,,1150.36
`;

const MAPPING = {
  date: 'Date', description: 'Description',
  paidIn: 'Paid In', paidOut: 'Paid Out', balance: 'Balance',
};

const OCR_GOOD = [
  'Your statement                              1 August 2026 to 31 August 2026',
  'Date       Description                    Paid out   Paid in    Balance',
  '03 Aug 26  CARD PAYMENT TO SCREWFIX          16.46              983.54',
  '04 Aug 26  BACS CREDIT PLUS DANE                        250.00  1,233.54',
  '05 Aug 26  DIRECT DEBIT NPOWER               83.18              1,150.36',
].join('\n');

/* ── tests ────────────────────────────────────────────────────────── */

describe('statement model indexes', () => {
  /** The index options Mongoose will hand to createIndex, keyed by field path. */
  const indexesOf = (schema) => Object.fromEntries(
    schema.indexes().map(([fields, options]) => [Object.keys(fields).join(','), { fields, options: options || {} }]),
  );

  it('does not use sparse for the nullable paperlessId', () => {
    // sparse only skips MISSING fields. paperlessId defaults to null, so every
    // uploaded statement writes an explicit null and a sparse unique index
    // rejects the second upload with a duplicate key error on null. A partial
    // index restricted to real numbers is what actually works here.
    const idx = indexesOf(statementImportModel.schema)['paperlessId'];
    assert.ok(idx, 'no paperlessId index declared');
    assert.equal(idx.options.unique, true);
    assert.notEqual(idx.options.sparse, true, 'sparse cannot express this — use partialFilterExpression');
    assert.deepEqual(idx.options.partialFilterExpression, { paperlessId: { $type: 'number' } });
  });

  it('keeps statement lines unique per account, ignoring soft-deleted rows', () => {
    const idx = indexesOf(statementLineModel.schema)['accountId,lineHash'];
    assert.ok(idx, 'no accountId+lineHash index declared');
    assert.equal(idx.options.unique, true);
    // Otherwise a soft-deleted line would permanently block its own re-import.
    assert.deepEqual(idx.options.partialFilterExpression, { deletedAt: null });
  });
});

describe('statementParserService', () => {

  describe('toPence()', () => {
    it('reads plain and formatted amounts', () => {
      assert.equal(toPence('16.46'), 1646);
      assert.equal(toPence('1,233.54'), 123354);
      assert.equal(toPence('£1,233.54'), 123354);
      assert.equal(toPence(16.46), 1646);
    });

    it('reads accountancy negatives and DR markers', () => {
      assert.equal(toPence('(84.20)'), -8420);
      assert.equal(toPence('84.20DR'), -8420);
      assert.equal(toPence('84.20CR'), 8420);
    });

    it('reads a Paperless monetary value with its currency prefix', () => {
      // A 'monetary' custom field comes back as "GBP1234.56", not a number.
      assert.equal(toPence('GBP1234.56'), 123456);
      assert.equal(toPence('GBP-84.20'), -8420);
      assert.equal(toPence('USD1,000.00'), 100000);
    });

    it('does not mistake letters for a currency prefix', () => {
      assert.equal(toPence('ABCDEF'), null);
      assert.equal(toPence('N/A'), null);
    });

    it('returns null for anything it cannot read, rather than guessing', () => {
      for (const bad of ['', null, undefined, 'n/a', 'abc', '--']) {
        assert.equal(toPence(bad), null, `toPence(${JSON.stringify(bad)})`);
      }
    });

    it('avoids float drift that would break a long balance chain', () => {
      // 0.1 + 0.2 !== 0.3 in floating point; in pence it is exact.
      assert.equal(toPence('0.1') + toPence('0.2'), toPence('0.3'));
    });
  });

  describe('parseStatementDate()', () => {
    it('reads UK day-first ordering', () => {
      const d = parseStatementDate('03/08/2026');
      assert.equal(d.getUTCDate(), 3);
      assert.equal(d.getUTCMonth(), 7); // August, not March
    });

    it('reads named months, two-digit years and ISO', () => {
      assert.equal(parseStatementDate('03 Aug 2026').getUTCMonth(), 7);
      assert.equal(parseStatementDate('03-08-26').getUTCFullYear(), 2026);
      assert.equal(parseStatementDate('2026-08-03').getUTCDate(), 3);
      assert.equal(parseStatementDate('20260803120000[0:GMT]').getUTCDate(), 3);
    });

    it('takes the year from the header when a line omits it', () => {
      assert.equal(parseStatementDate('03 Aug', { year: 2026 }).getUTCFullYear(), 2026);
      assert.equal(parseStatementDate('03 Aug'), null, 'no year anywhere must not be guessed');
    });

    it('rejects impossible dates instead of rolling them forward', () => {
      // Date would silently turn 31 February into 2 or 3 March.
      assert.equal(parseStatementDate('31/02/2026'), null);
      assert.equal(parseStatementDate('32/01/2026'), null);
      assert.equal(parseStatementDate('rubbish'), null);
    });

    it('lands at midday so a timezone shift cannot move the day', () => {
      assert.equal(parseStatementDate('03/08/2026').getUTCHours(), 12);
    });
  });

  describe('parseCsv()', () => {
    it('handles quoted fields containing commas', () => {
      const rows = parseCsv('a,b\n"SMITH, J & CO",12.00\n');
      assert.deepEqual(rows[1], ['SMITH, J & CO', '12.00']);
    });

    it('handles escaped quotes and blank lines', () => {
      const rows = parseCsv('a\n"He said ""hi"""\n\n');
      assert.equal(rows[1][0], 'He said "hi"');
      assert.equal(rows.length, 2);
    });
  });

  describe('validateBalanceChain()', () => {
    it('accepts a chain that reconciles', () => {
      const { lines } = parseCsvStatement(CSV_GOOD, { accountId: ACCOUNT, mapping: MAPPING });
      assert.equal(validateBalanceChain(lines).ok, true);
    });

    it('reports where the chain first breaks', () => {
      const { lines } = parseCsvStatement(CSV_CORRUPT, { accountId: ACCOUNT, mapping: MAPPING });
      const r = validateBalanceChain(lines);
      assert.equal(r.ok, false);
      assert.match(r.error, /Running balance breaks/);
      assert.match(r.error, /PLUS DANE/);
    });

    it('checks opening plus movement against closing', () => {
      const { lines } = parseCsvStatement(CSV_GOOD, { accountId: ACCOUNT, mapping: MAPPING });
      assert.equal(validateBalanceChain(lines, { openingBalance: 1000, closingBalance: 1150.36 }).ok, true);

      const wrong = validateBalanceChain(lines, { openingBalance: 1000, closingBalance: 1150.37 });
      assert.equal(wrong.ok, false);
      assert.match(wrong.error, /closes at/);
    });

    it('cannot verify a statement with no balance column', () => {
      const r = validateBalanceChain([{ date: new Date(), amount: 1, balance: null, description: '' }]);
      assert.equal(r.ok, false);
      assert.equal(r.checked, false);
      assert.match(r.error, /No running balance/);
    });
  });

  describe('parseCsvStatement()', () => {
    it('reads a paid in / paid out pair into signed amounts', () => {
      const { lines } = parseCsvStatement(CSV_GOOD, { accountId: ACCOUNT, mapping: MAPPING });
      assert.equal(lines.length, 3);
      assert.equal(lines[0].amount, -16.46, 'paid out is negative');
      assert.equal(lines[1].amount, 250, 'paid in is positive');
      assert.equal(lines[0].accountId, ACCOUNT);
    });

    it('reads a single signed amount column', () => {
      const csv = 'Date,Description,Amount,Balance\n03/08/2026,SCREWFIX,-16.46,983.54\n';
      const { lines } = parseCsvStatement(csv, {
        accountId: ACCOUNT,
        mapping: { date: 'Date', description: 'Description', amount: 'Amount', balance: 'Balance' },
      });
      assert.equal(lines[0].amount, -16.46);
    });

    it('accepts column indexes for a file with no usable header', () => {
      const csv = '03/08/2026,SCREWFIX,-16.46\n';
      const { lines } = parseCsvStatement(csv, {
        accountId: ACCOUNT, hasHeader: false,
        mapping: { date: 0, description: 1, amount: 2 },
      });
      assert.equal(lines[0].description, 'SCREWFIX');
    });

    it('skips unparseable rows with a warning rather than aborting the file', () => {
      const csv = `${CSV_GOOD}NOT A DATE,SOMETHING,1.00,,1.00\n`;
      const { lines, warnings } = parseCsvStatement(csv, { accountId: ACCOUNT, mapping: MAPPING });
      assert.equal(lines.length, 3);
      assert.ok(warnings.some(w => /unrecognised date/i.test(w)));
    });

    it('reports a mapping that does not fit the file', () => {
      const r = parseCsvStatement(CSV_GOOD, {
        accountId: ACCOUNT, mapping: { date: 'Nope', description: 'Description', amount: 'Amount' },
      });
      assert.equal(r.lines.length, 0);
      assert.match(r.warnings[0], /date column/);
    });
  });

  describe('parseOfxStatement()', () => {
    const OFX = `
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000[0:GMT]<TRNAMT>-16.46<FITID>1<NAME>SCREWFIX<MEMO>CARD PAYMENT</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260804120000[0:GMT]<TRNAMT>250.00<FITID>2<NAME>PLUS DANE</STMTTRN>
`;

    it('reads unclosed SGML-style tags', () => {
      const { lines } = parseOfxStatement(OFX, { accountId: ACCOUNT });
      assert.equal(lines.length, 2);
      assert.equal(lines[0].amount, -16.46);
      assert.equal(lines[1].amount, 250);
    });

    it('joins NAME and MEMO into one narrative', () => {
      const { lines } = parseOfxStatement(OFX, { accountId: ACCOUNT });
      assert.equal(lines[0].description, 'SCREWFIX CARD PAYMENT');
    });

    it('carries no balance, so such an import cannot be chain-checked', () => {
      // Recorded honestly: OFX has no per-transaction running balance.
      const { lines } = parseOfxStatement(OFX, { accountId: ACCOUNT });
      assert.equal(lines[0].balance, null);
      assert.equal(validateBalanceChain(lines).checked, false);
    });

    it('reports a file with no transactions', () => {
      const r = parseOfxStatement('<OFX></OFX>', { accountId: ACCOUNT });
      assert.equal(r.lines.length, 0);
      assert.match(r.warnings[0], /No <STMTTRN>/);
    });
  });

  describe('parseOcrStatement()', () => {
    it('reads a three-column layout, ignoring headers and preamble', () => {
      const { lines } = parseOcrStatement(OCR_GOOD, { accountId: ACCOUNT, year: 2026 });
      assert.equal(lines.length, 3);
      assert.equal(lines[0].amount, -16.46);
      assert.equal(lines[1].amount, 250);
      assert.equal(lines[2].balance, 1150.36);
    });

    it('rejoins a description wrapped onto the next line', () => {
      // The narrative is what the matcher reads, so a dropped continuation
      // loses the payee.
      const wrapped = [
        '03 Aug 26  CARD PAYMENT TO SCREWFIX          16.46              983.54',
        '           DIRECT LIMITED',
      ].join('\n');
      const { lines } = parseOcrStatement(wrapped, { accountId: ACCOUNT, year: 2026 });
      assert.equal(lines.length, 1);
      assert.match(lines[0].description, /SCREWFIX DIRECT LIMITED/);
    });

    it('reads a signed-amount layout under the matching profile', () => {
      const text = '03/08/2026  DIRECT DEBIT NPOWER   -84.20   1150.36';
      const { lines } = parseOcrStatement(text, { accountId: ACCOUNT, profile: 'uk-generic-signed' });
      assert.equal(lines[0].amount, -84.20);
    });

    it('reports an unknown profile', () => {
      const r = parseOcrStatement(OCR_GOOD, { accountId: ACCOUNT, profile: 'nope' });
      assert.match(r.warnings[0], /Unknown layout profile/);
    });

    it('reports a layout that matches nothing rather than returning silence', () => {
      const r = parseOcrStatement('complete nonsense\nwith no transactions', { accountId: ACCOUNT });
      assert.equal(r.lines.length, 0);
      assert.match(r.warnings[0], /No transaction lines matched/);
    });
  });

  describe('lineHash()', () => {
    const base = { accountId: ACCOUNT, date: new Date('2026-08-03T12:00:00Z'), amount: -16.46, description: 'SCREWFIX' };

    it('is stable across re-imports of identical data', () => {
      assert.equal(lineHash(base), lineHash({ ...base }));
    });

    it('ignores whitespace and case in the description', () => {
      assert.equal(lineHash(base), lineHash({ ...base, description: '  screwfix  ' }));
    });

    it('ignores the running balance', () => {
      // A bank can reprint the same transaction with a different balance if an
      // earlier line was later amended; that must still dedupe.
      assert.equal(lineHash(base), lineHash({ ...base, balance: 999 }));
    });

    it('changes when the amount, date or account changes', () => {
      assert.notEqual(lineHash(base), lineHash({ ...base, amount: -16.47 }));
      assert.notEqual(lineHash(base), lineHash({ ...base, date: new Date('2026-08-04T12:00:00Z') }));
      assert.notEqual(lineHash(base), lineHash({ ...base, accountId: 999 }));
    });
  });

  describe('parseStatement() — the trust decision', () => {
    it('marks a statement parsed when the balance chain verifies', () => {
      const r = parseStatement({ text: CSV_GOOD, accountId: ACCOUNT, format: 'csv', mapping: MAPPING });
      assert.equal(r.status, 'parsed');
      assert.equal(r.lines.length, 3);
      assert.equal(r.balance.ok, true);
    });

    it('marks a statement needs-review when ONE digit is wrong', () => {
      // The whole safety argument for accepting OCR at all. A transposed digit
      // produces a plausible line; only the chain catches it.
      const r = parseStatement({ text: CSV_CORRUPT, accountId: ACCOUNT, format: 'csv', mapping: MAPPING });
      assert.equal(r.status, 'needs-review');
      assert.notEqual(r.status, 'parsed');
      assert.ok(r.warnings.some(w => /Running balance breaks/.test(w)));
    });

    it('never reports parsed without a verified chain', () => {
      // OFX has no balance column, so it can never reach 'parsed' — it is
      // trusted by the reviewer, not by the parser.
      const ofx = '<STMTTRN><DTPOSTED>20260803<TRNAMT>-16.46<NAME>SCREWFIX</STMTTRN>';
      const r = parseStatement({ text: ofx, accountId: ACCOUNT, format: 'ofx' });
      assert.equal(r.status, 'needs-review');
      assert.equal(r.lines.length, 1);
    });

    it('marks an unreadable file failed, with no lines', () => {
      const r = parseStatement({ text: 'nothing useful here', accountId: ACCOUNT, format: 'csv', mapping: MAPPING });
      assert.equal(r.status, 'failed');
      assert.equal(r.lines.length, 0);
    });

    it('refuses a CSV with no column mapping', () => {
      const r = parseStatement({ text: CSV_GOOD, accountId: ACCOUNT, format: 'csv' });
      assert.equal(r.status, 'failed');
      assert.match(r.warnings[0], /column mapping/);
    });

    it('rejects an unsupported format', () => {
      const r = parseStatement({ text: 'x', accountId: ACCOUNT, format: 'pdf' });
      assert.equal(r.status, 'failed');
      assert.match(r.warnings[0], /Unsupported format/);
    });

    it('parses OCR text end to end and verifies its chain', () => {
      const r = parseStatement({ text: OCR_GOOD, accountId: ACCOUNT, format: 'ocr', year: 2026 });
      assert.equal(r.status, 'parsed');
      assert.equal(r.lines.length, 3);
      assert.equal(r.parserProfile, 'ocr:uk-generic-3col');
    });

    it('records which profile parsed it, so a bad profile can be traced', () => {
      const csv = parseStatement({ text: CSV_GOOD, accountId: ACCOUNT, format: 'csv', mapping: MAPPING });
      assert.equal(csv.parserProfile, 'csv');
    });
  });

  describe('dedupe across an overlapping re-import', () => {
    it('produces identical hashes for the rows the two exports share', () => {
      // People pull "last 3 months" repeatedly; the overlap must collapse.
      const first = parseCsvStatement(CSV_GOOD, { accountId: ACCOUNT, mapping: MAPPING });
      const secondCsv = `Date,Description,Paid Out,Paid In,Balance
04/08/2026,BACS CREDIT PLUS DANE HOUSING,,250.00,1233.54
05/08/2026,DIRECT DEBIT NPOWER,83.18,,1150.36
06/08/2026,CARD PAYMENT TO TOOLSTATION,42.00,,1108.36
`;
      const second = parseCsvStatement(secondCsv, { accountId: ACCOUNT, mapping: MAPPING });

      const firstHashes = new Set(first.lines.map(l => l.lineHash));
      const overlap = second.lines.filter(l => firstHashes.has(l.lineHash));
      assert.equal(overlap.length, 2, 'the two shared rows must hash identically');

      const novel = second.lines.filter(l => !firstHashes.has(l.lineHash));
      assert.equal(novel.length, 1);
      assert.match(novel[0].description, /TOOLSTATION/);
    });

    it('does not collapse two genuinely identical same-day transactions', () => {
      // A real risk: buy the same thing twice in one day for the same amount.
      // Both rows carry the same hash, so the second would be discarded as a
      // duplicate. Documented here as a known limitation of hashing rather
      // than pretended away — the running balance distinguishes them, and the
      // review screen is where a human resolves it.
      const csv = `Date,Description,Paid Out,Paid In,Balance
03/08/2026,CARD PAYMENT TO SCREWFIX,10.00,,990.00
03/08/2026,CARD PAYMENT TO SCREWFIX,10.00,,980.00
`;
      const { lines } = parseCsvStatement(csv, { accountId: ACCOUNT, mapping: MAPPING });
      assert.equal(lines.length, 2, 'the parser returns both');
      assert.equal(lines[0].lineHash, lines[1].lineHash, 'but they collide on hash — known limitation');
      // The chain still verifies, so the reviewer sees a consistent statement.
      assert.equal(validateBalanceChain(lines).ok, true);
    });
  });
});
