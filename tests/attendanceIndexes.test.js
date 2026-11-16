// Attendance duplicate-prevention indexes: each covers only its own kind of
// record, so two employees at one location on one day don't collide.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import attendanceModel, { UNIQUE_INDEXES } from '../mongoose/models/mongoose/INTERNAL/attendance.js';
import migration, { staleUniqueIndexes } from '../mongoose/services/attendanceIndexMigration.js';

describe('Attendance unique indexes', () => {
  it('are partial on their own person field, never sparse', () => {
    const declared = new Map(attendanceModel.schema.indexes().map(([keys, opts]) => [opts.name, { keys, opts }]));
    for (const ix of UNIQUE_INDEXES) {
      const d = declared.get(ix.name);
      assert.ok(d, `${ix.name} is declared`);
      assert.equal(d.opts.unique, true);
      assert.ok(!d.opts.sparse, `${ix.name} isn't sparse`);
      assert.deepEqual(d.opts.partialFilterExpression, { [ix.person]: { $type: 'objectId' } });
      assert.deepEqual(d.keys, ix.keys);
    }
  });

  it('finds the old sparse ones to replace, and leaves partial ones', () => {
    const stale = staleUniqueIndexes([
      { name: '_id_' },
      { name: 'unique_employee_day_location_project', sparse: true },
      { name: 'unique_subcontractor_day_location_project', partialFilterExpression: { subcontractorId: { $type: 'objectId' } } },
      { name: 'unique_subcontractor_day_location_contract', sparse: true },
    ]);
    assert.deepEqual(stale, ['unique_employee_day_location_project', 'unique_subcontractor_day_location_contract']);
  });

  describe('start-up migration', () => {
    let saved; let dropped; let created; let current;
    before(() => {
      saved = mdb.INTERNAL;
      mdb.INTERNAL = {
        attendance: {
          collection: { indexes: async () => current, dropIndex: async (n) => { dropped.push(n); } },
          createIndexes: async () => { created++; },
        },
      };
    });
    after(() => { mdb.INTERNAL = saved; });

    it('drops each stale index and creates the model\'s again', async () => {
      current = UNIQUE_INDEXES.map((ix) => ({ name: ix.name, sparse: true }));
      dropped = []; created = 0;
      const out = await migration.fixAttendanceUniqueIndexes();
      assert.equal(out.length, 4);
      assert.deepEqual(dropped, UNIQUE_INDEXES.map((ix) => ix.name));
      assert.equal(created, 1);
    });

    it('does nothing to drop once they are partial', async () => {
      current = UNIQUE_INDEXES.map((ix) => ({ name: ix.name, partialFilterExpression: {} }));
      dropped = []; created = 0;
      assert.deepEqual(await migration.fixAttendanceUniqueIndexes(), []);
      assert.deepEqual(dropped, []);
    });
  });
});
