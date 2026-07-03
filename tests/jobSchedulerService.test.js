const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../mongoose/services/jobSchedulerService');

describe('jobSchedulerService', () => {
  beforeEach(() => scheduler._reset());

  it('registers jobs and reports them in getStatus', () => {
    scheduler.register('a', { description: 'Job A', intervalMs: 1000, run: async () => 'ok' });
    scheduler.register('b', { description: 'Job B', intervalMs: 2000, run: async () => 'ok' });
    const status = scheduler.getStatus();
    assert.equal(status.length, 2);
    assert.deepEqual(status.map((j) => j.name).sort(), ['a', 'b']);
    assert.equal(status[0].runCount, 0);
    assert.equal(status[0].lastOutcome, null);
  });

  it('rejects duplicate registration', () => {
    scheduler.register('a', { intervalMs: 1000, run: async () => {} });
    assert.throws(() => scheduler.register('a', { intervalMs: 1000, run: async () => {} }), /already registered/);
  });

  it('rejects jobs without run', () => {
    assert.throws(() => scheduler.register('x', { intervalMs: 1000 }), /requires run/);
  });

  it('allows manual-only jobs (no intervalMs) and never schedules them', async () => {
    let calls = 0;
    scheduler.register('manual', { run: async () => { calls++; return 'done'; } });
    scheduler.start();
    const [status] = scheduler.getStatus();
    assert.equal(status.intervalMs, null);
    assert.equal(status.nextRunAt, null);
    const outcome = await scheduler.runNow('manual');
    assert.equal(outcome.ok, true);
    assert.equal(calls, 1);
    scheduler.stop();
  });

  it('runNow executes the job and records success status', async () => {
    let calls = 0;
    scheduler.register('a', { intervalMs: 1000, run: async () => { calls++; return { did: 'work' }; } });
    const outcome = await scheduler.runNow('a');
    assert.equal(outcome.ok, true);
    assert.equal(calls, 1);
    const [status] = scheduler.getStatus();
    assert.equal(status.runCount, 1);
    assert.equal(status.failCount, 0);
    assert.equal(status.lastOutcome, 'ok');
    assert.deepEqual(status.lastResult, { did: 'work' });
    assert.ok(status.lastRunAt instanceof Date);
    assert.ok(status.lastDurationMs >= 0);
  });

  it('runNow records failures without throwing', async () => {
    scheduler.register('a', { intervalMs: 1000, run: async () => { throw new Error('boom'); } });
    const outcome = await scheduler.runNow('a');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'boom');
    const [status] = scheduler.getStatus();
    assert.equal(status.failCount, 1);
    assert.equal(status.lastOutcome, 'error');
    assert.equal(status.lastError, 'boom');
  });

  it('runNow rejects unknown job names', async () => {
    await assert.rejects(() => scheduler.runNow('nope'), /Unknown job/);
  });

  it('skips overlapping runs (concurrency guard)', async () => {
    let resolveFirst;
    const gate = new Promise((res) => { resolveFirst = res; });
    let calls = 0;
    scheduler.register('slow', { intervalMs: 1000, run: async () => { calls++; await gate; } });

    const first = scheduler.runNow('slow');
    // Give the first run a tick to mark itself running
    await new Promise((r) => setImmediate(r));
    const second = await scheduler.runNow('slow');
    assert.equal(second.skipped, true);
    resolveFirst();
    await first;
    assert.equal(calls, 1);
  });

  it('truncates oversized job results in status', async () => {
    scheduler.register('big', { intervalMs: 1000, run: async () => ({ blob: 'x'.repeat(2000) }) });
    await scheduler.runNow('big');
    const [status] = scheduler.getStatus();
    assert.ok(typeof status.lastResult === 'string');
    assert.ok(status.lastResult.length <= 510);
  });
});
