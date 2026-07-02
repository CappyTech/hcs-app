'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_RATES, CORRECTIONS, ensureSeeded } =
  require('../mongoose/services/payrollTaxRatesSeedService');

// ── Shipped default data — guard against statutory regressions ──────────────

describe('DEFAULT_RATES data', () => {
  const y2526 = DEFAULT_RATES.find(r => r.taxYear === '2025/26');
  const y2627 = DEFAULT_RATES.find(r => r.taxYear === '2026/27');

  it('ships defaults for 2025/26 and 2026/27', () => {
    assert.ok(y2526);
    assert.ok(y2627);
  });

  it('employer NI is 15% (not 13.8%) for both years', () => {
    assert.equal(y2526.niEmployerRate, 0.15);
    assert.equal(y2627.niEmployerRate, 0.15);
  });

  it('2025/26 student loan thresholds are the published values', () => {
    assert.equal(y2526.studentLoanPlan1Threshold, 26065);
    assert.equal(y2526.studentLoanPlan2Threshold, 28470);
    assert.equal(y2526.studentLoanPlan4Threshold, 32745);
    assert.equal(y2526.studentLoanPostgradThreshold, 21000);
  });

  it('2026/27 student loan thresholds are the published values', () => {
    assert.equal(y2627.studentLoanPlan1Threshold, 26900);
    assert.equal(y2627.studentLoanPlan2Threshold, 29385);
    assert.equal(y2627.studentLoanPlan4Threshold, 33795);
  });

  it('category B reduced rate is 1.85%', () => {
    assert.equal(y2526.niEmployeeReducedRate, 0.0185);
    assert.equal(y2627.niEmployeeReducedRate, 0.0185);
  });

  it('every year carries the full field set the engine reads', () => {
    const required = [
      'personalAllowance', 'basicRateLimit', 'additionalRateThreshold',
      'basicRate', 'higherRate', 'additionalRate',
      'niLEL', 'niPT', 'niUEL', 'niEmployeeMain', 'niEmployeeUpper',
      'niST', 'niEmployerRate', 'aeQualifyingLower', 'aeQualifyingUpper'
    ];
    for (const year of DEFAULT_RATES) {
      for (const f of required) {
        assert.ok(year[f] != null, `${year.taxYear} missing ${f}`);
      }
    }
  });
});

// ── ensureSeeded behaviour (mocked model) ────────────────────────────────────

function mockModel({ upsertsInsert = true, correctionsMatch = false } = {}) {
  const calls = { updateOne: [], updateMany: [] };
  return {
    calls,
    updateOne: async (filter, update) => {
      calls.updateOne.push({ filter, update });
      if (update.$setOnInsert) {
        return { upsertedCount: upsertsInsert ? 1 : 0, modifiedCount: 0 };
      }
      return { upsertedCount: 0, modifiedCount: correctionsMatch ? 1 : 0 };
    },
    updateMany: async (filter, update) => {
      calls.updateMany.push({ filter, update });
      return { modifiedCount: 0 };
    }
  };
}

describe('ensureSeeded', () => {
  it('inserts missing years with $setOnInsert (never $set on whole documents)', async () => {
    const model = mockModel();
    const result = await ensureSeeded(model);

    const yearUpserts = model.calls.updateOne.filter(c => c.update.$setOnInsert);
    assert.equal(yearUpserts.length, DEFAULT_RATES.length);
    for (const call of yearUpserts) {
      assert.equal(call.update.$set, undefined, 'whole-year writes must be insert-only');
    }
    assert.deepEqual(result.created, DEFAULT_RATES.map(r => r.taxYear));
  });

  it('reports nothing created when all years already exist', async () => {
    const model = mockModel({ upsertsInsert: false });
    const result = await ensureSeeded(model);
    assert.deepEqual(result.created, []);
  });

  it('corrections filter on the exact known-bad value, so admin edits are untouched', async () => {
    const model = mockModel();
    await ensureSeeded(model);

    const correctionCalls = model.calls.updateOne.filter(c => !c.update.$setOnInsert);
    assert.equal(correctionCalls.length, CORRECTIONS.length);
    for (const [i, call] of correctionCalls.entries()) {
      const c = CORRECTIONS[i];
      assert.equal(call.filter.taxYear, c.taxYear);
      assert.equal(call.filter[c.field], c.from, 'correction must match the old bad value');
      assert.deepEqual(call.update.$set, { [c.field]: c.to });
    }
  });

  it('counts applied corrections', async () => {
    const model = mockModel({ upsertsInsert: false, correctionsMatch: true });
    const result = await ensureSeeded(model);
    assert.equal(result.corrected, CORRECTIONS.length);
  });

  it('backfills niEmployeeReducedRate only where the field is missing', async () => {
    const model = mockModel();
    await ensureSeeded(model);
    assert.equal(model.calls.updateMany.length, 1);
    assert.deepEqual(model.calls.updateMany[0].filter, { niEmployeeReducedRate: { $exists: false } });
    assert.deepEqual(model.calls.updateMany[0].update, { $set: { niEmployeeReducedRate: 0.0185 } });
  });

  it('includes the 13.8% → 15% employer NI correction for both years', () => {
    const employerFixes = CORRECTIONS.filter(c => c.field === 'niEmployerRate');
    assert.deepEqual(employerFixes.map(c => c.taxYear).sort(), ['2025/26', '2026/27']);
    for (const fix of employerFixes) {
      assert.equal(fix.from, 0.138);
      assert.equal(fix.to, 0.15);
    }
  });

  it('throws when the model is unavailable', async () => {
    await assert.rejects(() => ensureSeeded(null), /not available/);
  });
});
