const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildKashFlowPayloadFromDraft } = require('../mongoose/services/paperless/purchaseDraftService');

// Helper: build a minimal draft with one line item
function draft(lineItem) {
  return {
    SupplierCode: 'TEST',
    LineItems: [{ Description: 'item', Quantity: 1, ...lineItem }],
  };
}

// Extract VATLevel from the first line item of the payload
function vatLevel(payload) {
  return payload.LineItems[0].VATLevel;
}

// ─── VATLevel rounding (no vatLevels list → round to nearest 5%) ────────────

describe('VATLevel rounding to nearest 5% (no vatLevels provided)', () => {
  it('20% exact  → 20', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 20 }));
    assert.equal(vatLevel(p), 20);
  });

  it('0% exact   → 0', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 0 }));
    assert.equal(vatLevel(p), 0);
  });

  it('5% exact   → 5', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 200, VATAmount: 10 }));
    assert.equal(vatLevel(p), 5);
  });

  it('19.8%      → 20', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 19.8 }));
    assert.equal(vatLevel(p), 20);
  });

  it('17.5%      → 20  (rounds up from midpoint)', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 17.5 }));
    assert.equal(vatLevel(p), 20);
  });

  it('12.4%      → 10  (rounds down)', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 12.4 }));
    assert.equal(vatLevel(p), 10);
  });

  it('2.1%       → 0', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 2.1 }));
    assert.equal(vatLevel(p), 0);
  });

  it('7.3%       → 5', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 7.3 }));
    assert.equal(vatLevel(p), 5);
  });

  it('15% exact  → 15', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 15 }));
    assert.equal(vatLevel(p), 15);
  });

  it('10% exact  → 10', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 10 }));
    assert.equal(vatLevel(p), 10);
  });
});

// ─── Derive net from GrossAmount ─────────────────────────────────────────────

describe('VATLevel derived from GrossAmount', () => {
  it('Gross=120, VAT=20 → net=100 → 20%', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ GrossAmount: 120, VATAmount: 20 }));
    assert.equal(vatLevel(p), 20);
  });

  it('Gross=105, VAT=5 → net=100 → 5%', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ GrossAmount: 105, VATAmount: 5 }));
    assert.equal(vatLevel(p), 5);
  });
});

// ─── Derive net from Quantity × UnitPrice ────────────────────────────────────

describe('VATLevel derived from Quantity × UnitPrice', () => {
  it('Qty=2, UnitPrice=50, VAT=20 → net=100 → 20%', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ Quantity: 2, UnitPrice: 50, VATAmount: 20 }));
    assert.equal(vatLevel(p), 20);
  });
});

// ─── Snapping to provided vatLevels list ─────────────────────────────────────

describe('VATLevel snapping to known vatLevels', () => {
  const levels = [0, 5, 20];

  it('19.8% snaps to 20 with vatLevels=[0,5,20]', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 19.8 }), { vatLevels: levels });
    assert.equal(vatLevel(p), 20);
  });

  it('4.6% snaps to 5 with vatLevels=[0,5,20]', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 4.6 }), { vatLevels: levels });
    assert.equal(vatLevel(p), 5);
  });

  it('0.3% snaps to 0 with vatLevels=[0,5,20]', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 0.3 }), { vatLevels: levels });
    assert.equal(vatLevel(p), 0);
  });

  it('exact 20% stays 20 with vatLevels=[0,5,20]', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 20 }), { vatLevels: levels });
    assert.equal(vatLevel(p), 20);
  });
});

// ─── Pre-set VATLevel passes through unchanged ──────────────────────────────

describe('Explicit VATLevel on line item passes through', () => {
  it('VATLevel=20 is preserved', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ VATLevel: 20, NetAmount: 100, VATAmount: 20 }));
    assert.equal(vatLevel(p), 20);
  });

  it('VATLevel=0 is preserved', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ VATLevel: 0, NetAmount: 100, VATAmount: 0 }));
    assert.equal(vatLevel(p), 0);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('VATLevel edge cases', () => {
  it('VATAmount=0 with no net → returns 0', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ VATAmount: 0 }));
    assert.equal(vatLevel(p), 0);
  });

  it('No VATAmount at all → VATLevel is undefined', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100 }));
    assert.equal(vatLevel(p), undefined);
  });

  it('Negative net (impossible) → VATLevel undefined', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: -10, VATAmount: 5 }));
    assert.equal(vatLevel(p), undefined);
  });
});
