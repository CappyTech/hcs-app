import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { customFieldValue } from '../mongoose/services/paperless/customFieldValue.js';

/** Custom field values go to Paperless in their field's type (#253: Credit Note is boolean). */

describe('customFieldValue', () => {
  it('booleans', () => {
    for (const v of [true, 'true', 'TRUE', '1', 'yes', 'on']) assert.equal(customFieldValue('boolean', v), true, String(v));
    for (const v of [false, 'false', '0', 'no', 'off', '']) assert.equal(customFieldValue('boolean', v), false, String(v));
    assert.throws(() => customFieldValue('boolean', 'maybe'), /isn't true or false/);
  });

  it('numbers', () => {
    assert.equal(customFieldValue('integer', '42'), 42);
    assert.equal(customFieldValue('float', '1.5'), 1.5);
    assert.throws(() => customFieldValue('float', 'abc'), /isn't a number/);
  });

  it('everything else stays text', () => {
    assert.equal(customFieldValue('monetary', 'GBP12.99'), 'GBP12.99');
    assert.equal(customFieldValue('string', 148184160), '148184160');
    assert.equal(customFieldValue('date', '2026-01-20'), '2026-01-20');
    assert.equal(customFieldValue(undefined, 5), '5');
  });

  it('the client sends both ways of setting fields through it', () => {
    const src = fs.readFileSync(path.resolve('mongoose/services/paperless/paperlessClient.js'), 'utf8');
    assert.match(src, /addCustomFields\[fid\] = customFieldValue\(_cfTypeById\.get\(Number\(fid\)\), value\)/);
    assert.match(src, /existing\.set\(Number\(fid\), customFieldValue\(_cfTypeById\.get\(Number\(fid\)\), value\)\)/);
    assert.equal((src.match(/^\s+_rememberCfTypes\(defs\);/gm) || []).length, 2, 'both listings remember the types');
  });
});

describe('ticking Credit Note (mock Paperless)', () => {
  let mock;
  before(async () => {
    process.env.PAPERLESS_URL = 'mock';
    mock = await import('../mongoose/services/paperless/mock/paperlessMockClient.js');
  });
  after(() => { delete process.env.PAPERLESS_URL; });
  beforeEach(() => mock.resetMockPaperless());

  it('sets it as a boolean, as Paperless requires', async () => {
    const id = mock.mockPaperlessState().documents[0].id;
    await mock.makeMockClient().setDocumentCustomFields([id], { 'Credit Note': 'true' });
    const cf = mock.mockPaperlessState().documents[0].custom_fields.find((e) => e.field === 58);
    assert.equal(cf.value, true);
  });
});
