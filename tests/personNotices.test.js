import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Person notices: telling employees and subcontractors about their weekly
 * attendance, their pay and policy documents (personNoticeService), and the
 * places that call it (weekly sheet save and import, attendance approval,
 * payroll lock / recalculate / amend, policy create / edit).
 * notifyService.notifyUsers is mocked and mdb.INTERNAL is replaced with
 * in-memory fakes: nothing is sent and no database is touched.
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import notifyService from '../services/notifyService.js';
import notices, {
  dayLabel, weeklyLinkFor, policyNeedsNotice, entryFingerprint, hashOf,
} from '../mongoose/services/personNoticeService.js';
import { resolvePayrollWeek } from '../mongoose/services/attendanceService.js';
import weeklySheet from '../mongoose/services/weeklySheetService.js';
import approval from '../mongoose/services/attendanceApprovalService.js';

// The payroll controller loads encryptionService, which needs a key at import
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests-only';
const { default: payrollCtrl } = await import('../mongoose/controllers/payrollController.js');
const { default: companyDocs } = await import('../mongoose/controllers/companyDocsController.js');

const E1 = '0000000000000000000000e1';
const E2 = '0000000000000000000000e2';
const E3 = '0000000000000000000000e3';
const S1 = '0000000000000000000000a1';
const U1 = { _id: 'u1', email: 'one@example.test', employeeId: E1 };
const U1B = { _id: 'u1b', email: 'one-b@example.test', employeeId: E1 };
const U2 = { _id: 'u2', email: 'two@example.test', employeeId: E2 };
const US = { _id: 'us', email: 'sub@example.test', subcontractorId: S1 };
const BOSS = { _id: 'boss', email: 'boss@example.test', role: 'admin' };

// ── Fakes ───────────────────────────────────────────────────────────────

const idsIn = (cond) => (cond && cond.$in ? cond.$in.map(String) : null);
const chain = (value) => {
  const c = { select: () => c, sort: () => c, populate: () => c, lean: async () => value, then: (ok, bad) => Promise.resolve(value).then(ok, bad) };
  return c;
};
/** user.find({ $or: [{ employeeId: { $in } }, { subcontractorId: { $in } }] }) */
function userModel(users) {
  return {
    find(q) {
      const res = users.filter((u) => (q.$or || []).some((cond) => {
        const [field, v] = Object.entries(cond)[0];
        return u[field] && idsIn(v).includes(String(u[field]));
      }));
      return chain(res);
    },
  };
}

let calls;
function mockNotify(impl) {
  calls = [];
  mock.method(notifyService, 'notifyUsers', async (args) => {
    calls.push(args);
    if (impl) return impl(args);
    return { recipients: args.users.length, email: args.users.length, sms: 0, inApp: args.users.length, skipped: 0 };
  });
}
const userIdsOf = (call) => call.users.map((u) => String(u._id)).sort();

let savedINTERNAL;
let savedREST;
before(() => { savedINTERNAL = mdb.INTERNAL; savedREST = mdb.REST; });
after(() => { mdb.INTERNAL = savedINTERNAL; mdb.REST = savedREST; });
afterEach(() => mock.restoreAll());

// ── Pure helpers ────────────────────────────────────────────────────────

describe('Person notice helpers', () => {
  it('labels days as on the sheet: "Mon 23 Nov"', () => {
    assert.equal(dayLabel('2026-11-23'), 'Mon 23 Nov');
    assert.equal(dayLabel('2026-05-03'), 'Sun 3 May');
  });

  it('links a day to the payroll week (Saturday to Friday) on /weekly that holds it', () => {
    for (const day of ['2026-11-23', '2026-11-21', '2026-04-06', '2027-03-30', '2026-01-02']) {
      const link = weeklyLinkFor(day);
      const m = link.match(/^\/weekly\/(\d{4})\/(\d+)$/);
      assert.ok(m, `${day} → ${link}`);
      assert.ok(resolvePayrollWeek(Number(m[1]), Number(m[2])).days.includes(day), `${day} is in ${link}`);
    }
    assert.equal(weeklyLinkFor('not-a-day'), '/weekly');
  });

  it('tells about a policy when it is published, or a published one gets a new version or owner', () => {
    assert.equal(policyNeedsNotice(null, { isPublished: true }), true);
    assert.equal(policyNeedsNotice(null, { isPublished: false }), false);
    assert.equal(policyNeedsNotice({ isPublished: false, version: '1.0' }, { isPublished: true, version: '1.0' }), true);
    assert.equal(policyNeedsNotice({ isPublished: true, version: '1.0' }, { isPublished: true, version: '1.0' }), false, 'a typo fix is not a new version');
    assert.equal(policyNeedsNotice({ isPublished: true, version: '1.0' }, { isPublished: true, version: '1.1' }), true);
    assert.equal(policyNeedsNotice({ isPublished: true, version: '1.0', employee: E1 }, { isPublished: true, version: '1.0', employee: E2 }), true);
    assert.equal(policyNeedsNotice({ isPublished: true, version: '1.0' }, { isPublished: false, version: '2.0' }), false, 'unpublishing tells no one');
  });

  it('fingerprints an entry by what the employee is paid', () => {
    const e = { grossPay: '500.00', netPay: '420.00', taxDeducted: '50.00', paymentDate: new Date('2026-11-27'), employerNI: '30' };
    assert.equal(entryFingerprint(e), entryFingerprint({ ...e }));
    assert.notEqual(entryFingerprint(e), entryFingerprint({ ...e, netPay: '421.00' }));
    assert.equal(entryFingerprint(e), entryFingerprint({ ...e, employerNI: '31' }), "the employer's costs are not the employee's pay");
  });
});

// ── Weekly attendance ───────────────────────────────────────────────────

describe('Weekly sheet notices', () => {
  const db = { INTERNAL: { user: userModel([U1, U1B, U2, US, BOSS]) } };
  const changes = [
    { key: `e:${E1}`, day: '2026-11-24', beforeLabel: '', afterLabel: 'Off', stamp: 'r2|' },
    { key: `e:${E1}`, day: '2026-11-23', beforeLabel: '41296 3 Centre Court', afterLabel: 'Office', stamp: 'r1|100' },
    { key: `e:${E2}`, day: '2026-11-25', beforeLabel: 'Office', afterLabel: '', stamp: 'r3|200' },
    { key: `e:${E3}`, day: '2026-11-25', beforeLabel: '', afterLabel: 'Office', stamp: 'r4|' }, // no linked user
    { key: `s:${S1}`, day: '2026-11-26', beforeLabel: '', afterLabel: '41296 3 Centre Court', stamp: 'r5|' },
  ];

  it('sends one notice per person listing their changed days, to their linked users only', async () => {
    mockNotify();
    const sent = await notices.sheetSaved({ monday: '2026-11-23', changes, actorId: BOSS._id, db });
    assert.equal(sent, 3);
    assert.equal(calls.length, 3);
    const one = calls.find((c) => c.dedupeKey.endsWith(`:e:${E1}`));
    assert.deepEqual(userIdsOf(one), ['u1', 'u1b']);
    assert.equal(one.type, 'attendance');
    assert.match(one.text, /Mon 23 Nov: 41296 3 Centre Court → Office\nTue 24 Nov: Off/);
    assert.equal(one.link, weeklyLinkFor('2026-11-23'));
    assert.match(one.subject, /2 days/);
    assert.doesNotMatch(one.smsText, /Centre Court/);
    const two = calls.find((c) => c.dedupeKey.endsWith(`:e:${E2}`));
    assert.deepEqual(userIdsOf(two), ['u2']);
    assert.match(two.text, /Wed 25 Nov: Office → removed/);
    const sub = calls.find((c) => c.dedupeKey.endsWith(`:s:${S1}`));
    assert.deepEqual(userIdsOf(sub), ['us']);
    assert.ok(calls.every((c) => !c.users.some((u) => u._id === BOSS._id)));
  });

  it("doesn't tell the person about a change they made themselves", async () => {
    mockNotify();
    await notices.sheetSaved({ monday: '2026-11-23', changes: changes.slice(0, 3), actorId: 'u2', db });
    assert.equal(calls.length, 1, "E2's only user made the change");
    assert.deepEqual(userIdsOf(calls[0]), ['u1', 'u1b']);
  });

  it('uses a stable dedupe key: the same save gives the same key, a later identical change a new one', async () => {
    mockNotify();
    await notices.sheetSaved({ monday: '2026-11-23', changes: changes.slice(0, 2), db });
    await notices.sheetSaved({ monday: '2026-11-23', changes: [...changes.slice(0, 2)].reverse(), db });
    await notices.sheetSaved({ monday: '2026-11-23', changes: [{ ...changes[1], stamp: 'r1|900' }, changes[0]], db });
    assert.match(calls[0].dedupeKey, new RegExp(`^attendance:sheet:2026-11-23:[0-9a-f]{16}:e:${E1}$`));
    assert.equal(calls[0].dedupeKey, calls[1].dedupeKey);
    assert.notEqual(calls[0].dedupeKey, calls[2].dedupeKey);
  });

  it('never throws when notifying fails', async () => {
    mockNotify(() => { throw new Error('outbox down'); });
    const sent = await notices.sheetSaved({ monday: '2026-11-23', changes, db });
    assert.equal(sent, 0);
    const brokenDb = { INTERNAL: { user: { find: () => { throw new Error('db down'); } } } };
    assert.equal(await notices.sheetSaved({ monday: '2026-11-23', changes, db: brokenDb }), null);
  });
});

describe('Weekly sheet save tells people', () => {
  const OFFICE = '0000000000000000000000f1';
  const CENTRE = '0000000000000000000000c1';
  const query = (rows) => chain(rows);
  const model = (rows, extra = {}) => ({ find: () => query(rows()), findOne: () => query(null), distinct: async () => [], ...extra });
  let store;
  class FakeAttendance {
    constructor(fields) { Object.assign(this, fields); }
    set(k, v) { if (v === undefined) delete this[k]; else this[k] = v; }
    async save() { if (!this._id) { this._id = `new${store.length}`; store.push(this); } this.updatedAt = new Date(); }
    async deleteOne() { store = store.filter((r) => r !== this); }
  }
  FakeAttendance.find = () => query(store);
  FakeAttendance.findById = async (rid) => store.find((r) => r._id === rid) || null;
  FakeAttendance.distinct = async () => [];
  const employees = [
    { _id: E1, uuid: 'e1', name: 'Alex', department: 'Office', status: 'active' },
    { _id: E2, uuid: 'e2', name: 'Sam', department: 'Office', status: 'active' },
  ];

  beforeEach(() => {
    mdb.INTERNAL = {
      employee: model(() => employees),
      attendance: FakeAttendance,
      contract: model(() => [{ _id: CENTRE, uuid: 'c1', title: '41296 3 Centre Court', status: 'In Progress' }]),
      location: model(() => [{ _id: OFFICE, uuid: 'l1', name: 'Office' }]),
      holidayRequest: model(() => []), holiday: model(() => []), holidayCustom: model(() => []),
      payrollRun: model(() => []), vehicle: model(() => []), jobRegister: model(() => []), employeeHoliday: model(() => []),
      user: userModel([U1, U2, BOSS]),
    };
    mdb.REST = { supplier: model(() => []), project: model(() => []) };
  });

  it('one notice per person for the save, with what each day was and is now; not the person who saved', async () => {
    mockNotify();
    store = [new FakeAttendance({ _id: 'r1', date: new Date(2026, 10, 23), type: 'work', status: 'planned', employeeId: E1, contractId: CENTRE, updatedAt: new Date(1000) })];
    const a = `e:${E1}`; const b = `e:${E2}`;
    const result = await weeklySheet.saveSheet('2026-11-23', {
      cell: { [a]: { '2026-11-23': `loc:${OFFICE}`, '2026-11-24': 'off' }, [b]: { '2026-11-23': `con:${CENTRE}` } },
      was: { [a]: { '2026-11-23': `con:${CENTRE}`, '2026-11-24': '' }, [b]: { '2026-11-23': '' } },
    }, { actorId: 'u2' });
    assert.deepEqual(result, { saved: 3, skipped: 0 });
    assert.equal(calls.length, 1, 'Sam saved the sheet, so only Alex is told');
    assert.deepEqual(userIdsOf(calls[0]), ['u1']);
    assert.match(calls[0].text, /Mon 23 Nov: 41296 3 Centre Court → Office/);
    assert.match(calls[0].text, /Tue 24 Nov: Off/);
  });

  it('a failing notice never breaks the save', async () => {
    mockNotify(() => { throw new Error('outbox down'); });
    store = [];
    const a = `e:${E1}`;
    const result = await weeklySheet.saveSheet('2026-11-23', { cell: { [a]: { '2026-11-25': 'sick' } }, was: { [a]: { '2026-11-25': '' } } }, { actorId: BOSS._id });
    assert.deepEqual(result, { saved: 1, skipped: 0 });
    assert.equal(calls.length, 1);
  });

  it('saving nothing tells no one', async () => {
    mockNotify();
    store = [];
    const result = await weeklySheet.saveSheet('2026-11-23', { cell: {}, was: {} });
    assert.deepEqual(result, { saved: 0, skipped: 0 });
    assert.equal(calls.length, 0);
  });
});

describe('Weekly sheet import notices', () => {
  const db = { INTERNAL: { user: userModel([U1, U2, BOSS]) } };

  it('one notice per person per import, listing their days, with a key per upload and days written', async () => {
    mockNotify();
    const days = [
      { key: `e:${E1}`, day: '2026-11-17', label: 'Office', stamp: 'a1' },
      { key: `e:${E1}`, day: '2026-11-16', label: '41296 3 Centre Court', stamp: 'a2' },
      { key: `e:${E2}`, day: '2026-11-16', label: 'Off', stamp: 'a3' },
    ];
    await notices.importedDays({ uploadId: 'up1', days, actorId: BOSS._id, db });
    assert.equal(calls.length, 2);
    const one = calls.find((c) => c.dedupeKey.endsWith(`:e:${E1}`));
    assert.match(one.dedupeKey, new RegExp(`^attendance:import:up1:[0-9a-f]{16}:e:${E1}$`));
    assert.match(one.text, /Mon 16 Nov: 41296 3 Centre Court\nTue 17 Nov: Office/);
    assert.equal(one.link, weeklyLinkFor('2026-11-16'));
    // The same import again gives the same keys (nothing new queued)
    await notices.importedDays({ uploadId: 'up1', days, actorId: BOSS._id, db });
    assert.equal(calls[2].dedupeKey === calls[0].dedupeKey || calls[2].dedupeKey === calls[1].dedupeKey, true);
  });

  it('lists at most 14 days, then how many more', async () => {
    mockNotify();
    const days = Array.from({ length: 20 }, (_, i) => ({ key: `e:${E1}`, day: `2026-10-${String(i + 1).padStart(2, '0')}`, label: 'Office', stamp: `x${i}` }));
    await notices.importedDays({ uploadId: 'up2', days, db });
    assert.match(calls[0].text, /and 6 more days$/);
    assert.match(calls[0].subject, /^20 days/);
  });
});

// ── Approval ────────────────────────────────────────────────────────────

describe('Attendance approval notices', () => {
  const past = (d) => new Date(2026, 10, d);
  function attendanceModel(rows) {
    return {
      findOne: ({ uuid }) => ({ lean: async () => rows.find((r) => r.uuid === uuid) || null }),
      async findOneAndUpdate(filter, update) {
        const r = rows.find((x) => String(x._id) === String(filter._id) && (x.status || 'pending') === filter.status);
        if (!r) return null;
        Object.assign(r, update.$set || update);
        return r;
      },
      find(filter) {
        const res = rows.filter((r) => (filter.status?.$in ? filter.status.$in.includes(r.status)
          : filter._id?.$in ? filter._id.$in.some((x) => String(x) === String(r._id)) && r.status === filter.status : true));
        const p = Promise.resolve(res);
        p.lean = async () => res;
        return p;
      },
      async updateMany(filter, update) {
        let n = 0;
        for (const r of rows) if (filter._id.$in.some((x) => String(x) === String(r._id)) && r.status === filter.status) { Object.assign(r, update); n++; }
        return { modifiedCount: n };
      },
    };
  }
  const dbWith = (rows) => ({ INTERNAL: { attendance: attendanceModel(rows), contract: { find: () => chain([]) }, user: userModel([U1, U2, US, BOSS]) } });
  const reqFor = (user) => ({ user, _projectScope: Promise.resolve({ contractIds: [], projectIds: [] }) });
  const row = (id, over) => ({ _id: id, uuid: `uu-${id}`, date: past(16), type: 'work', status: 'pending', ...over });

  it('approving a range: one notice per person for all their approved days', async () => {
    mockNotify();
    const rows = [
      row('a1', { employeeId: E1, date: past(16) }),
      row('a2', { employeeId: E1, date: past(17) }),
      row('a3', { employeeId: E2, date: past(16) }),
      row('a4', { subcontractorId: S1, date: past(18) }),
    ];
    const { counts } = await approval.approveRange(reqFor(BOSS), new Date(0), new Date(), dbWith(rows));
    assert.equal(counts.approved, 4);
    assert.equal(calls.length, 3);
    const one = calls.find((c) => c.dedupeKey.endsWith(`:e:${E1}`));
    assert.match(one.subject, /approved: 2 days/);
    assert.match(one.text, /Mon 16 Nov\nTue 17 Nov/);
    assert.match(one.dedupeKey, new RegExp(`^attendance:approved:[0-9a-f]{16}:e:${E1}$`));
    assert.deepEqual(userIdsOf(calls.find((c) => c.dedupeKey.endsWith(`:s:${S1}`))), ['us']);
  });

  it('rejecting tells the person, with the reason', async () => {
    mockNotify();
    const rows = [row('b1', { employeeId: E1 })];
    const res = await approval.rejectOne(reqFor(BOSS), 'uu-b1', 'Wrong site', dbWith(rows));
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /Reason: Wrong site/);
    assert.match(calls[0].smsText, /rejected: Wrong site/);
    assert.match(calls[0].subject, /Attendance rejected: Mon 16 Nov/);
    assert.match(calls[0].dedupeKey, /^attendance:rejected:/);
  });

  it('the site step tells no one; the final approval does; marking not attended does', async () => {
    mockNotify();
    const rows = [row('c1', { employeeId: E1 })];
    const res = await approval.approveOne(reqFor(BOSS), 'uu-c1', dbWith(rows));
    assert.equal(res.next, 'approved');
    assert.equal(calls.length, 1);
    assert.match(calls[0].subject, /Attendance approved/);

    const rows2 = [row('c2', { employeeId: E2 })];
    await approval.notAttendedOne(reqFor(BOSS), 'uu-c2', dbWith(rows2));
    assert.equal(calls.length, 2);
    assert.match(calls[1].subject, /marked not attended/);
  });

  it("doesn't tell someone about their own approval or confirmation", async () => {
    mockNotify();
    const selfAdmin = { ...BOSS, _id: 'u1', employeeId: E1 };
    const rows = [row('d1', { employeeId: E1 })];
    const db = { INTERNAL: { ...dbWith(rows).INTERNAL, user: userModel([{ ...U1 }, U2]) } };
    await approval.approveOne(reqFor(selfAdmin), 'uu-d1', db);
    assert.equal(calls.length, 0);
    // Confirming one's own planned day is self-service: never told
    const rows2 = [row('d2', { employeeId: E1, status: 'planned' })];
    const res = await approval.confirmOne(reqFor({ ...U1, role: 'employee' }), 'uu-d2', dbWith(rows2));
    assert.equal(res.ok, true);
    assert.equal(calls.length, 0);
  });

  it('a failing notice never breaks the approval', async () => {
    mockNotify(() => { throw new Error('outbox down'); });
    const rows = [row('e1', { employeeId: E1 })];
    const res = await approval.approveOne(reqFor(BOSS), 'uu-e1', dbWith(rows));
    assert.equal(res.ok, true);
    assert.equal(rows[0].status, 'approved');
  });
});

// ── Payroll ─────────────────────────────────────────────────────────────

describe('Payroll notices', () => {
  let run; let entries; let entryUpdates;
  const RUN_ID = 'run1';
  function install(users = [U1, U2, BOSS]) {
    entryUpdates = [];
    const runDoc = () => Object.assign(run, { async save() {} });
    mdb.INTERNAL = {
      user: userModel(users),
      payrollRun: { findOne: () => chain(runDoc()) },
      payrollEntry: {
        find: ({ runId }) => chain(entries.filter((e) => e.runId === runId)),
        findOne: ({ uuid }) => chain(entries.find((e) => e.uuid === uuid) || null),
        countDocuments: async () => entries.length,
        async updateOne({ _id }, { $set }) {
          entryUpdates.push({ _id, $set });
          Object.assign(entries.find((e) => e._id === _id), $set);
          return { modifiedCount: 1 };
        },
      },
    };
  }
  const res = () => ({ redirect() {}, status() { return this; }, json(v) { this.body = v; return this; }, send() {} });
  const req = (over = {}) => ({ params: { uuid: 'r-uuid' }, user: BOSS, body: {}, flash() {}, ...over });

  beforeEach(() => {
    run = { _id: RUN_ID, uuid: 'r-uuid', status: 'draft', taxYear: '2026/27', taxWeek: 33, frequency: 'weekly', periodStart: new Date('2026-11-14'), periodEnd: new Date('2026-11-20'), paymentDate: new Date('2026-11-27') };
    entries = [
      { _id: 'pe1', uuid: 'pe1-u', runId: RUN_ID, employeeId: E1, netPay: '420.00', grossPay: '500.00', paymentDate: run.paymentDate, noticeFingerprint: null },
      { _id: 'pe2', uuid: 'pe2-u', runId: RUN_ID, employeeId: E2, netPay: '380.00', grossPay: '450.00', paymentDate: run.paymentDate, noticeFingerprint: null },
      { _id: 'pe3', uuid: 'pe3-u', runId: RUN_ID, employeeId: E3, netPay: '300.00', grossPay: '350.00', paymentDate: run.paymentDate, noticeFingerprint: null },
    ];
  });

  it('locking a run tells each employee their pay is settled: no amounts, period and payment date only', async () => {
    mockNotify();
    install();
    await payrollCtrl.lockRun(req(), res(), (e) => { throw e; });
    assert.equal(run.status, 'locked');
    assert.equal(calls.length, 2, 'E3 has no user');
    const one = calls.find((c) => userIdsOf(c)[0] === 'u1');
    assert.equal(one.type, 'payroll');
    assert.equal(one.subject, 'Your pay is settled');
    assert.equal(one.dedupeKey, `payroll:${RUN_ID}:locked:${E1}`);
    assert.match(one.text, /tax week 33, 2026\/27/);
    assert.match(one.text, /27 Nov 2026/);
    for (const c of calls) {
      assert.doesNotMatch(`${c.subject} ${c.text} ${c.smsText}`, /420|380|500|450|£/);
      assert.equal(c.link ?? null, null, 'no payslip page for employees yet');
    }
    assert.equal(entryUpdates.length, 3, 'every entry remembers what it was told, user or not');
    // Locking again (after an unlock) with nothing changed tells no one
    await payrollCtrl.lockRun(req(), res(), (e) => { throw e; });
    assert.equal(calls.length, 2);
  });

  it('an entry amended after the lock: that employee is told their pay was updated', async () => {
    mockNotify();
    install();
    run.status = 'locked';
    await notices.payrollRunChanged(RUN_ID);
    assert.equal(calls.length, 2);
    await payrollCtrl.overrideEntry(req({ params: { uuid: 'r-uuid', entryUuid: 'pe1-u' }, body: { netPay: '410.00' } }), res(), (e) => { throw e; });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].subject, 'Your pay has been updated');
    assert.deepEqual(userIdsOf(calls[2]), ['u1']);
    assert.match(calls[2].dedupeKey, new RegExp(`^payroll:${RUN_ID}:updated:${E1}:[0-9a-f]{16}$`));
    assert.doesNotMatch(calls[2].smsText, /410|£/);
  });

  it('a draft run tells no one', async () => {
    mockNotify();
    install();
    assert.equal(await notices.payrollRunChanged(RUN_ID), 0);
    assert.equal(calls.length, 0);
  });

  it('a failed notice is tried again next time, and never breaks the lock', async () => {
    mockNotify(() => { throw new Error('outbox down'); });
    install();
    await payrollCtrl.lockRun(req(), res(), (e) => { throw e; });
    assert.equal(run.status, 'locked');
    assert.equal(entries[0].noticeFingerprint, null, 'not marked as told');
    mockNotify();
    await notices.payrollRunChanged(RUN_ID);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].subject, 'Your pay is settled');
  });
});

// ── Policies ────────────────────────────────────────────────────────────

describe('Policy notices', () => {
  const POLICY_UUID = 'pol-1';
  let docs;
  function install(users = [U1, U2, US, BOSS]) {
    mdb.INTERNAL = {
      user: userModel(users),
      employee: { find: (q) => chain(q.status === 'active' ? [{ _id: E1 }, { _id: E2 }] : []) },
      policyDocument: {
        async create(fields) { const d = { _id: 'p1', uuid: POLICY_UUID, ...fields }; docs.push(d); return d; },
        findOne: ({ uuid }) => {
          const d = docs.find((x) => x.uuid === uuid);
          return d ? Object.assign(d, { async save() {} }) : null;
        },
      },
    };
  }
  const res = () => ({ redirect() {} });
  const req = (body, over = {}) => ({ body, params: { uuid: POLICY_UUID }, user: BOSS, session: { user: { id: BOSS._id } }, ...over });
  const form = (over = {}) => ({ title: 'Lone working', category: 'Health & Safety', version: '1.0', contentHtml: '<p>x</p>', isPublished: 'on', ...over });

  beforeEach(() => { docs = []; });

  it('a company policy published: every user linked to an active employee, no subcontractors, no link', async () => {
    mockNotify();
    install();
    await companyDocs.postCreatePolicy(req(form()), res(), (e) => { throw e; });
    assert.equal(calls.length, 1);
    assert.deepEqual(userIdsOf(calls[0]), ['u1', 'u2']);
    assert.equal(calls[0].type, 'policy-update');
    assert.equal(calls[0].dedupeKey, `policy:${POLICY_UUID}:1.0`);
    assert.equal(calls[0].link, null);
    assert.match(calls[0].subject, /Policy published: Lone working/);
  });

  it('an individual document: only that employee, linked to the document', async () => {
    mockNotify();
    install();
    await companyDocs.postCreatePolicy(req(form({ employee: E2, title: 'Contract' })), res(), (e) => { throw e; });
    assert.equal(calls.length, 1);
    assert.deepEqual(userIdsOf(calls[0]), ['u2']);
    assert.equal(calls[0].link, `/company-docs/policies/${POLICY_UUID}/print`);
  });

  it('a draft tells no one; publishing it does; a new version does; an edit without one does not', async () => {
    mockNotify();
    install();
    await companyDocs.postCreatePolicy(req(form({ isPublished: undefined })), res(), (e) => { throw e; });
    assert.equal(calls.length, 0);
    await companyDocs.postEditPolicy(req(form()), res(), (e) => { throw e; });
    assert.equal(calls.length, 1);
    await companyDocs.postEditPolicy(req(form({ contentHtml: '<p>typo fixed</p>' })), res(), (e) => { throw e; });
    assert.equal(calls.length, 1);
    await companyDocs.postEditPolicy(req(form({ version: '1.1' })), res(), (e) => { throw e; });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].dedupeKey, `policy:${POLICY_UUID}:1.1`);
  });

  it("the person who published it isn't told", async () => {
    mockNotify();
    install();
    await companyDocs.postCreatePolicy(req(form(), { user: U1, session: { user: { id: 'u1' } } }), res(), (e) => { throw e; });
    assert.deepEqual(userIdsOf(calls[0]), ['u2']);
  });

  it('a failing notice never breaks the publish', async () => {
    mockNotify(() => { throw new Error('outbox down'); });
    install();
    let redirected = null;
    await companyDocs.postCreatePolicy(req(form()), { redirect: (to) => { redirected = to; } }, (e) => { throw e; });
    assert.equal(redirected, '/company-docs/policies');
    assert.equal(docs.length, 1);
  });

  it('dedupe keys are stable per thing', () => {
    assert.equal(hashOf(['a', 'b']), hashOf(['a', 'b']));
    assert.notEqual(hashOf(['a', 'b']), hashOf(['b', 'a']));
  });
});
