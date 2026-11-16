// Who's on the weekly sheet: each week starts with the week before's people;
// adding or removing someone changes that week onwards. Invented data only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import weeklySheet, { effectivePeople, changeOverrides, copyFromYesterday, buildSheet, resolveWeek, GROUPS } from '../mongoose/services/weeklySheetService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const E1 = 'e:' + '1'.repeat(24);
const E2 = 'e:' + '2'.repeat(24);
const S1 = 's:' + 'a'.repeat(24);

describe('Weekly sheet people', () => {
  it('starts from the defaults, applies the changes in force, and always shows anyone with records', () => {
    assert.deepEqual([...effectivePeople({ defaults: [E1, E2] })], [E1, E2]);
    assert.deepEqual([...effectivePeople({ defaults: [E1, E2], overrides: { added: [S1], removed: [E2] } })], [E1, S1]);
    assert.deepEqual([...effectivePeople({ defaults: [E1, E2], overrides: { removed: [E2] }, withRecords: [E2] })], [E1, E2]);
  });

  it('adding someone takes them off the removed list, and removing does the reverse', () => {
    assert.deepEqual(changeOverrides(null, S1, 'add'), { added: [S1], removed: [] });
    assert.deepEqual(changeOverrides({ added: [S1], removed: [E2] }, E2, 'add'), { added: [S1, E2], removed: [] });
    assert.deepEqual(changeOverrides({ added: [S1], removed: [] }, S1, 'remove'), { added: [], removed: [S1] });
  });

  describe('stored per week, inherited by the weeks after', () => {
    let saved; let docs; let lastQuery;
    before(() => {
      saved = mdb.INTERNAL;
      const one = (fn) => { const o = { sort: () => o, select: () => o, lean: async () => fn() }; return o; };
      mdb.INTERNAL = {
        weeklySheetPeople: {
          // the nearest week on or before the one asked for
          findOne: (f) => { lastQuery = f; return one(() => docs.filter((d) => d.monday <= f.monday.$lte).sort((a, b) => b.monday.localeCompare(a.monday))[0] || null); },
          updateOne: async (f, u) => {
            const d = docs.find((x) => x.monday === f.monday);
            if (d) Object.assign(d, u.$set); else docs.push({ monday: f.monday, ...u.$set });
          },
        },
      };
    });
    after(() => { mdb.INTERNAL = saved; });

    it('a week with no changes of its own uses the week before; a change copies them into the week', async () => {
      docs = [{ monday: '2026-11-02', added: [S1], removed: [] }];
      assert.deepEqual((await weeklySheet.fetchOverrides('2026-11-16')).added, [S1]);
      assert.equal(lastQuery.monday.$lte, '2026-11-16');
      const r = await weeklySheet.changePeople('2026-11-18', E2, 'remove', 'u1'); // any day in the week
      assert.equal(r.monday, '2026-11-16');
      assert.deepEqual(docs.find((d) => d.monday === '2026-11-16'), { monday: '2026-11-16', added: [S1], removed: [E2], updatedBy: 'u1' });
      assert.deepEqual(docs.find((d) => d.monday === '2026-11-02').removed, []); // earlier weeks untouched
      assert.deepEqual((await weeklySheet.fetchOverrides('2026-11-23')).removed, [E2]); // later weeks follow
    });

    it('refuses anything that is not a person', async () => {
      await assert.rejects(weeklySheet.changePeople('2026-11-16', 'x:bad', 'add'), (e) => e.status === 400);
      await assert.rejects(weeklySheet.changePeople('2026-11-16', E1, 'delete'), (e) => e.status === 400);
    });
  });

  it('draws a remove button on each row and the Add someone form', async () => {
    const week = resolveWeek('2026-11-16', '2026-11-16');
    const sheet = buildSheet({
      week, employees: [{ _id: '1'.repeat(24), uuid: 'u', name: 'Alex Example', department: 'Office' }], subcontractors: [],
      attendance: [], contracts: [], locations: [],
    });
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/attendance/weekly-sheet.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], week, sheet, closures: new Map(), running: [], jobs: [], vehicles: [],
      group: '', groups: GROUPS, dayLabels: week.days, addChoices: {
        employees: [{ value: E2, label: 'Former Person', inactive: true }], subcontractors: [{ value: S1, label: 'Example Sub Ltd' }],
      },
    });
    assert.match(html, new RegExp(`formaction="/weekly-sheet/2026-11-16/people/remove" name="removePerson" value="${E1}"`));
    assert.match(html, /action="\/weekly-sheet\/2026-11-16\/people\/add"/);
    assert.match(html, /<optgroup label="Former employees"><option value="e:2+">Former Person/);
    assert.match(html, /Example Sub Ltd/);
    assert.doesNotMatch(html, /<script/);
  });
});

describe('Loading the sheet with people added and removed', () => {
  let saved;
  const id1 = '1'.repeat(24); const id2 = '2'.repeat(24); const id3 = '3'.repeat(24); const sub = 'a'.repeat(24);
  const q = (rows) => { const o = { select: () => o, sort: () => o, lean: () => o, populate: () => o, then: (ok, bad) => Promise.resolve(rows).then(ok, bad) }; return o; };
  const model = (rows) => ({ find: () => q(rows), findOne: () => q(null), distinct: async () => [] });
  before(() => {
    saved = { INTERNAL: mdb.INTERNAL, REST: mdb.REST };
    const people = {
      [id1]: { _id: id1, uuid: 'a', name: 'Active Kept', department: 'Office', status: 'active' },
      [id2]: { _id: id2, uuid: 'b', name: 'Active Removed', department: 'Office', status: 'active' },
      [id3]: { _id: id3, uuid: 'c', name: 'Former Added', department: 'Landscaping', status: 'inactive' },
    };
    mdb.INTERNAL = {
      employee: { find: (f) => q(f.status ? [people[id1], people[id2]] : f._id.$in.map((x) => people[x])) },
      attendance: { find: () => q([]), distinct: async () => [] },
      contract: model([]), location: model([]), holidayRequest: model([]), holiday: model([]), holidayCustom: model([]),
      payrollRun: model([]), vehicle: model([]), jobRegister: model([]), employeeHoliday: model([]),
      weeklySheetPeople: { findOne: () => { const o = { sort: () => o, select: () => o, lean: async () => ({ monday: '2026-11-09', added: [`e:${id3}`, `s:${sub}`], removed: [`e:${id2}`] }) }; return o; } },
    };
    mdb.REST = { supplier: { find: () => q([{ _id: sub, uuid: 's', Name: 'Added Sub Ltd' }]) }, project: model([]) };
  });
  after(() => { mdb.INTERNAL = saved.INTERNAL; mdb.REST = saved.REST; });

  it('shows the active people not removed, plus the former employee and subcontractor added', async () => {
    const data = await weeklySheet.loadSheet('2026-11-16');
    const names = data.sheet.allRows.map((r) => r.name).sort();
    assert.deepEqual(names, ['Active Kept', 'Added Sub Ltd', 'Former Added']);
  });
});

describe('Copy from yesterday (per person)', () => {
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  const SITE = 'con:' + 'c'.repeat(24);
  const OFFICE = 'loc:' + 'f'.repeat(24);
  const cell = (day, over = {}) => ({ day, editable: true, value: '', records: [], ...over });
  const rows = [
    { key: E1, name: 'Alex', cells: [cell(days[0], { value: SITE }), cell(days[1]), cell(days[2], { editable: false, records: [{ type: 'work', locationId: 'f'.repeat(24) }] }), cell(days[3]), ...days.slice(4).map((d) => cell(d))] },
    { key: E2, name: 'Sam', cells: days.map((d, i) => cell(d, { value: i === 0 ? OFFICE : '' })) },
  ];
  const allowed = new Set([SITE, OFFICE]);

  it('copies only that person\'s day before into the day', () => {
    const r = copyFromYesterday({ rows, days, person: E1, day: days[1], allowed });
    assert.equal(r.copied, 1);
    assert.equal(r.from, days[0]);
    assert.equal(r.draft[E1][days[1]], SITE);
    assert.equal(r.draft[E2][days[1]], ''); // Sam untouched
  });

  it('works from what is on the form, not just what is saved', () => {
    const r = copyFromYesterday({ rows, days, person: E2, day: days[1], allowed, cells: { [E2]: { [days[0]]: SITE } } });
    assert.equal(r.draft[E2][days[0]], SITE);
    assert.equal(r.draft[E2][days[1]], SITE);
  });

  it('copies a signed-off day before from its record, and never onto Monday or a locked day', () => {
    assert.equal(copyFromYesterday({ rows, days, person: E1, day: days[3], allowed }).draft[E1][days[3]], OFFICE);
    assert.equal(copyFromYesterday({ rows, days, person: E1, day: days[0], allowed }).copied, 0);
    assert.equal(copyFromYesterday({ rows, days, person: E1, day: days[2], allowed }).copied, 0);
    assert.equal(copyFromYesterday({ rows, days, person: E2, day: days[2], allowed }).copied, 0); // empty day before
  });

  it('draws a copy button on Tuesday to Sunday only, and shows a copied value as unsaved', async () => {
    const week = resolveWeek('2026-11-16', '2026-11-16');
    const sheet = buildSheet({ week, employees: [{ _id: '1'.repeat(24), uuid: 'u', name: 'Alex Example', department: 'Office' }], subcontractors: [], attendance: [], contracts: [], locations: [{ _id: 'f'.repeat(24), name: 'Office' }] });
    sheet.allRows[0].cells[1].draft = OFFICE;
    const html = await ejs.renderFile(path.join(root, 'mongoose/views/tailwindcss/attendance/weekly-sheet.ejs'), {
      title: 't', csrfToken: 'c', crumbs: [], week, sheet, closures: new Map(), running: [], jobs: [], vehicles: [],
      group: '', groups: GROUPS, dayLabels: week.days, addChoices: { employees: [], subcontractors: [] }, notice: 'Copied. Not saved yet',
    });
    const buttons = html.match(/name="copy" value="[^"]+"/g) || [];
    assert.equal(buttons.length, 6);
    assert.ok(!buttons.some((b) => b.includes('2026-11-16')));
    assert.match(html, /<option value="loc:f+" selected>Office/);
    assert.ok(html.includes(`name="was[${E1}][2026-11-17]" value=""`)); // saved value unchanged, so Save week sees the change
    assert.match(html, /Not saved yet/);
  });
});
