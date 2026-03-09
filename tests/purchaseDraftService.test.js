const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildKashFlowPayloadFromDraft,
  buildPurchaseDraftFromOcr,
  defaultMap,
} = require('../mongoose/services/paperless/purchaseDraftService');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Minimal draft with one line item
function draft(lineItem, headerOverrides = {}) {
  return {
    SupplierCode: 'TEST',
    LineItems: [{ Description: 'item', Quantity: 1, ...lineItem }],
    ...headerOverrides,
  };
}

// Minimal OCR document with custom fields
function ocr(fields = {}, lineFields = []) {
  const customFields = [];
  for (const [fieldName, value] of Object.entries(fields)) {
    customFields.push({ fieldName, value });
  }
  for (const lf of lineFields) {
    customFields.push(lf);
  }
  return {
    paperlessId: 1,
    title: 'Test Invoice',
    customFields,
    correspondent: { name: 'Test Supplier' },
    created: '2026-01-15',
  };
}

// Extract VATLevel from first payload line item
function vatLevel(payload) {
  return payload.LineItems[0].VATLevel;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  buildKashFlowPayloadFromDraft
// ═══════════════════════════════════════════════════════════════════════════════

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

  it('Qty=3, Rate=25, VAT=15 → net=75 → 20%', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ Quantity: 3, Rate: 25, VATAmount: 15 }));
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

  it('fractional levels: 12% snaps to 12.5 with vatLevels=[0,5,12.5,20]', () => {
    const p = buildKashFlowPayloadFromDraft(
      draft({ NetAmount: 100, VATAmount: 12 }),
      { vatLevels: [0, 5, 12.5, 20] },
    );
    assert.equal(vatLevel(p), 12.5);
  });

  it('10% snaps to closest in vatLevels=[0,5,12.5,20] → 12.5', () => {
    const p = buildKashFlowPayloadFromDraft(
      draft({ NetAmount: 100, VATAmount: 10 }),
      { vatLevels: [0, 5, 12.5, 20] },
    );
    assert.equal(vatLevel(p), 12.5);
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

// ─── Realistic penny amounts (floating-point edge cases) ────────────────────

describe('Realistic OCR amounts with pennies', () => {
  it('Net=347.83, VAT=69.57 → ~19.997% → 20', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 347.83, VATAmount: 69.57 }));
    assert.equal(vatLevel(p), 20);
  });

  it('Net=1249.50, VAT=249.90 → 20%', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 1249.50, VATAmount: 249.90 }));
    assert.equal(vatLevel(p), 20);
  });

  it('Net=83.33, VAT=16.67 → ~20.004% → 20', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 83.33, VATAmount: 16.67 }));
    assert.equal(vatLevel(p), 20);
  });

  it('Net=0.01, VAT=0.00 → 0%', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 0.01, VATAmount: 0 }));
    assert.equal(vatLevel(p), 0);
  });

  it('Net=47.99, VAT=2.40 → ~5.001% → 5', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 47.99, VATAmount: 2.40 }));
    assert.equal(vatLevel(p), 5);
  });
});

// ─── Multiple line items with mixed VAT rates ───────────────────────────────

describe('Multiple line items with mixed VAT rates', () => {
  it('two lines: 20% and 0% both resolve correctly', () => {
    const d = {
      SupplierCode: 'MULTI',
      LineItems: [
        { Description: 'Standard rated', Quantity: 1, NetAmount: 100, VATAmount: 20 },
        { Description: 'Zero rated', Quantity: 1, NetAmount: 50, VATAmount: 0 },
      ],
    };
    const p = buildKashFlowPayloadFromDraft(d);
    assert.equal(p.LineItems.length, 2);
    assert.equal(p.LineItems[0].VATLevel, 20);
    assert.equal(p.LineItems[1].VATLevel, 0);
  });

  it('three lines: 20%, 5%, 0% with vatLevels list', () => {
    const d = {
      SupplierCode: 'MULTI',
      LineItems: [
        { Description: 'Standard', Quantity: 2, NetAmount: 200, VATAmount: 40 },
        { Description: 'Reduced', Quantity: 1, NetAmount: 100, VATAmount: 5 },
        { Description: 'Exempt', Quantity: 1, NetAmount: 75, VATAmount: 0 },
      ],
    };
    const p = buildKashFlowPayloadFromDraft(d, { vatLevels: [0, 5, 20] });
    assert.equal(p.LineItems[0].VATLevel, 20);
    assert.equal(p.LineItems[1].VATLevel, 5);
    assert.equal(p.LineItems[2].VATLevel, 0);
  });
});

// ─── Payload structure ──────────────────────────────────────────────────────

describe('Payload structure (buildKashFlowPayloadFromDraft)', () => {
  it('includes SupplierCode and SupplierReference', () => {
    const p = buildKashFlowPayloadFromDraft(draft(
      { NetAmount: 100, VATAmount: 20 },
      { SupplierCode: 'SUP01', SupplierReference: 'INV-001' },
    ));
    assert.equal(p.SupplierCode, 'SUP01');
    assert.equal(p.SupplierReference, 'INV-001');
  });

  it('formats dates as YYYY-MM-DD HH:mm:ss', () => {
    const p = buildKashFlowPayloadFromDraft(draft(
      { NetAmount: 100, VATAmount: 20 },
      { SupplierCode: 'S', IssuedDate: new Date('2026-03-01T00:00:00Z'), DueDate: '2026-04-01' },
    ));
    assert.match(p.IssuedDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(p.DueDate, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('sets Currency.Code defaulting to GBP', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 20 }));
    assert.equal(p.Currency.Code, 'GBP');
  });

  it('overrides Currency.Code via opts.currencyDefault', () => {
    const p = buildKashFlowPayloadFromDraft(
      draft({ NetAmount: 100, VATAmount: 20 }),
      { currencyDefault: 'USD' },
    );
    assert.equal(p.Currency.Code, 'USD');
  });

  it('carries Currency from draft itself', () => {
    const p = buildKashFlowPayloadFromDraft(draft(
      { NetAmount: 100, VATAmount: 20 },
      { SupplierCode: 'S', Currency: 'EUR' },
    ));
    assert.equal(p.Currency.Code, 'EUR');
  });

  it('line item has Description, Quantity, Rate, VATLevel, VATAmount', () => {
    const p = buildKashFlowPayloadFromDraft(draft({
      Description: 'Widget', Quantity: 3, UnitPrice: 10, NetAmount: 30, VATAmount: 6,
    }));
    const li = p.LineItems[0];
    assert.equal(li.Description, 'Widget');
    assert.equal(li.Quantity, 3);
    assert.equal(li.Rate, 10);
    assert.equal(li.VATAmount, 6);
    assert.equal(li.VATLevel, 20);
  });

  it('Rate falls back to NetAmount when no UnitPrice', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 50, VATAmount: 10 }));
    assert.equal(p.LineItems[0].Rate, 50);
  });

  it('ProjectNumber is included when numeric', () => {
    const p = buildKashFlowPayloadFromDraft(draft(
      { NetAmount: 100, VATAmount: 20 },
      { SupplierCode: 'S', ProjectNumber: 42 },
    ));
    assert.equal(p.ProjectNumber, 42);
  });

  it('pruned payload has no undefined keys', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 20 }));
    // Recursively check no value is undefined
    const hasUndefined = (obj) => {
      if (obj == null) return false;
      if (Array.isArray(obj)) return obj.some(hasUndefined);
      if (typeof obj === 'object') {
        return Object.entries(obj).some(([, v]) => v === undefined || hasUndefined(v));
      }
      return false;
    };
    assert.equal(hasUndefined(p), false);
  });
});

// ─── PaymentLines ────────────────────────────────────────────────────────────

describe('PaymentLines mapping', () => {
  it('maps PaymentLines through to payload', () => {
    const p = buildKashFlowPayloadFromDraft({
      SupplierCode: 'S',
      LineItems: [{ Description: 'x', NetAmount: 100, VATAmount: 20 }],
      PaymentLines: [
        { AccountId: 1, Amount: 120, Date: '2026-03-01', Method: 'BACS', Note: 'paid' },
      ],
    });
    assert.equal(p.PaymentLines.length, 1);
    assert.equal(p.PaymentLines[0].AccountId, 1);
    assert.equal(p.PaymentLines[0].Amount, 120);
    assert.equal(p.PaymentLines[0].Method, 'BACS');
    assert.match(p.PaymentLines[0].Date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('omits PaymentLines when not present on draft', () => {
    const p = buildKashFlowPayloadFromDraft(draft({ NetAmount: 100, VATAmount: 20 }));
    assert.equal(p.PaymentLines, undefined);
  });
});

// ─── Input validation ────────────────────────────────────────────────────────

describe('Input validation (buildKashFlowPayloadFromDraft)', () => {
  it('throws on null draft', () => {
    assert.throws(() => buildKashFlowPayloadFromDraft(null), /draft required/);
  });

  it('throws on undefined draft', () => {
    assert.throws(() => buildKashFlowPayloadFromDraft(undefined), /draft required/);
  });

  it('throws on non-object draft', () => {
    assert.throws(() => buildKashFlowPayloadFromDraft('string'), /draft required/);
  });

  it('returns empty LineItems when draft has no LineItems', () => {
    const p = buildKashFlowPayloadFromDraft({ SupplierCode: 'S' });
    assert.deepEqual(p.LineItems, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  buildPurchaseDraftFromOcr — maybePercent path
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildPurchaseDraftFromOcr: VATLevel from percent fields', () => {
  it('integer 20 detected as percent → VATLevel rounds to 20', () => {
    const d = buildPurchaseDraftFromOcr(ocr(
      { 'Net': '100.00' },
      [
        { fieldName: 'Description_Line1', value: 'Service' },
        { fieldName: 'Net_Line1', value: '100.00' },
        { fieldName: 'VAT_Line1', value: 20 },
      ],
    ));
    const li = d.LineItems[0];
    assert.equal(li.VATLevel, 20);
    assert.equal(li.VATAmount, 20);
  });

  it('integer 5 detected as percent → VATLevel=5, VATAmount=5', () => {
    const d = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'Reduced rate item' },
        { fieldName: 'Net_Line1', value: '100.00' },
        { fieldName: 'VAT_Line1', value: 5 },
      ],
    ));
    const li = d.LineItems[0];
    assert.equal(li.VATLevel, 5);
    assert.equal(li.VATAmount, 5);
  });

  it('integer 0 detected as percent → VATLevel=0, VATAmount=0', () => {
    const d = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'Exempt item' },
        { fieldName: 'Net_Line1', value: '50.00' },
        { fieldName: 'VAT_Line1', value: 0 },
      ],
    ));
    const li = d.LineItems[0];
    assert.equal(li.VATLevel, 0);
    assert.equal(li.VATAmount, 0);
  });

  it('"20%" string with % symbol → VATLevel=20', () => {
    const d = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'Goods' },
        { fieldName: 'Net_Line1', value: '200.00' },
        { fieldName: 'VAT_Line1', value: '20%' },
      ],
    ));
    const li = d.LineItems[0];
    assert.equal(li.VATLevel, 20);
    assert.equal(li.VATAmount, 40);
  });

  it('19 rounds to 20, 21 rounds to 20', () => {
    const d19 = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'A' },
        { fieldName: 'Net_Line1', value: '100' },
        { fieldName: 'VAT_Line1', value: 19 },
      ],
    ));
    assert.equal(d19.LineItems[0].VATLevel, 20);

    const d21 = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'B' },
        { fieldName: 'Net_Line1', value: '100' },
        { fieldName: 'VAT_Line1', value: 21 },
      ],
    ));
    assert.equal(d21.LineItems[0].VATLevel, 20);
  });

  it('3 rounds to 5, 8 rounds to 10', () => {
    const d3 = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'A' },
        { fieldName: 'Net_Line1', value: '100' },
        { fieldName: 'VAT_Line1', value: 3 },
      ],
    ));
    assert.equal(d3.LineItems[0].VATLevel, 5);

    const d8 = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'B' },
        { fieldName: 'Net_Line1', value: '100' },
        { fieldName: 'VAT_Line1', value: 8 },
      ],
    ));
    assert.equal(d8.LineItems[0].VATLevel, 10);
  });

  it('decimal VAT "19.80" is treated as monetary, not percent', () => {
    const d = buildPurchaseDraftFromOcr(ocr(
      {},
      [
        { fieldName: 'Description_Line1', value: 'Goods' },
        { fieldName: 'Net_Line1', value: '100.00' },
        { fieldName: 'VAT_Line1', value: '19.80' },
      ],
    ));
    const li = d.LineItems[0];
    // Should NOT set VATLevel (decimal = money, not percent)
    assert.equal(li.VATLevel, undefined);
    assert.equal(li.VATAmount, 19.80);
  });
});

describe('buildPurchaseDraftFromOcr: header-level amounts', () => {
  it('derives VATAmount when Net and Gross provided', () => {
    const d = buildPurchaseDraftFromOcr(ocr({
      'Net Amount': '100.00',
      'Total': '120.00',
    }));
    assert.equal(d.VATAmount, 20);
    assert.equal(d.GrossAmount, 120);
    assert.equal(d.NetAmount, 100);
  });

  it('derives NetAmount when Gross and VAT provided', () => {
    const d = buildPurchaseDraftFromOcr(ocr({
      'VAT Amount': '20.00',
      'Total': '120.00',
    }));
    assert.equal(d.NetAmount, 100);
  });

  it('derives GrossAmount when Net and VAT provided', () => {
    const d = buildPurchaseDraftFromOcr(ocr({
      'Net Amount': '100.00',
      'VAT Amount': '20.00',
    }));
    assert.equal(d.GrossAmount, 120);
  });
});

describe('buildPurchaseDraftFromOcr: input validation', () => {
  it('throws on null ocr', () => {
    assert.throws(() => buildPurchaseDraftFromOcr(null), /ocr document required/);
  });

  it('throws on non-object ocr', () => {
    assert.throws(() => buildPurchaseDraftFromOcr(42), /ocr document required/);
  });
});

// ─── defaultMap export ──────────────────────────────────────────────────────

describe('defaultMap export', () => {
  it('is an object with expected keys', () => {
    assert.equal(typeof defaultMap, 'object');
    const expectedKeys = ['SupplierName', 'SupplierCode', 'SupplierReference', 'IssuedDate',
      'DueDate', 'NetAmount', 'VATAmount', 'GrossAmount', 'Currency', 'Notes', 'LineItems'];
    for (const k of expectedKeys) {
      assert.ok(Array.isArray(defaultMap[k]), `defaultMap.${k} should be an array`);
    }
  });
});
