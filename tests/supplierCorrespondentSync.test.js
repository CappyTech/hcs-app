import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import svc from '../mongoose/services/paperless/supplierCorrespondentSyncService.js';
const { computeMissingCorrespondents, normaliseName } = svc;

describe('normaliseName', () => {
  it('trims, collapses whitespace and lowercases', () => {
    assert.equal(normaliseName('  ACME   Ltd  '), 'acme ltd');
  });
  it('tolerates null/undefined', () => {
    assert.equal(normaliseName(null), '');
    assert.equal(normaliseName(undefined), '');
  });
});

describe('computeMissingCorrespondents', () => {
  it('creates suppliers with no matching correspondent', () => {
    const out = computeMissingCorrespondents(['Acme Ltd', 'Beta Co'], ['Acme Ltd']);
    assert.deepEqual(out, ['Beta Co']);
  });

  it('matches existing correspondents case- and whitespace-insensitively', () => {
    const out = computeMissingCorrespondents(['ACME  LTD'], ['acme ltd']);
    assert.deepEqual(out, []);
  });

  it('preserves the original supplier spelling for names it creates', () => {
    const out = computeMissingCorrespondents(['Beta Co'], []);
    assert.deepEqual(out, ['Beta Co']);
  });

  it('deduplicates supplier names that differ only by case/whitespace', () => {
    const out = computeMissingCorrespondents(['Beta Co', 'beta  co', 'BETA CO'], []);
    assert.deepEqual(out, ['Beta Co']); // first spelling wins, created once
  });

  it('ignores blank and whitespace-only supplier names', () => {
    const out = computeMissingCorrespondents(['', '   ', 'Real Co'], []);
    assert.deepEqual(out, ['Real Co']);
  });

  it('returns nothing when there are no suppliers', () => {
    assert.deepEqual(computeMissingCorrespondents([], ['Acme Ltd']), []);
  });
});
