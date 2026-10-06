/**
 * Real invoices as regression tests for the reader.
 *
 * Each tests/fixtures/invoices/*.json is a saved invoice exported from
 * /paperless/reading ("Fixture"): its positioned text and what was saved on
 * the entry screen. The reader must still find every saved value, except any
 * listed in the fixture's "knownMisses" (layouts it can't read yet).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFields, normalise, FIELDS } from '../public/js/invoice-field-finder.js';
import { findLines } from '../public/js/invoice-line-finder.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'invoices');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
const TYPE = Object.fromEntries(FIELDS.map((f) => [f.field, f.type]));
const unpack = ([str, x, y, w, h, page]) => ({ str, x, y, w, h, page });

describe('invoice fixtures', () => {
  it('has fixtures to run', () => assert.ok(files.length > 0));

  for (const file of files) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const skip = new Set(fx.knownMisses || []);
    it(`${file} (${fx.supplier || 'unknown supplier'})`, () => {
      const items = fx.items.map(unpack);
      const found = findFields(items, { pageWidth: fx.pageWidth || 595 });
      for (const f of FIELDS.map((d) => d.field)) {
        const want = fx.expected[f];
        if (want == null || skip.has(f)) continue;
        assert.equal(normalise(TYPE[f], found[f]?.value), normalise(TYPE[f], want), `${f}`);
      }
      const lines = (fx.expected.lines || []).filter((l) => l.total != null);
      if (lines.length && !skip.has('lines')) {
        const got = findLines(items);
        assert.deepEqual(got.map((l) => Number(l.total).toFixed(2)), lines.map((l) => Number(l.total).toFixed(2)), 'line totals');
      }
    });
  }
});
