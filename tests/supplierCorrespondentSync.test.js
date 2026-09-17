import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import svc from '../mongoose/services/paperless/supplierCorrespondentSyncService.js';
const { computeMissingCorrespondents, normaliseName, canonicalName } = svc;

describe('normaliseName', () => {
  it('trims, collapses whitespace and lowercases', () => {
    assert.equal(normaliseName('  ACME   Ltd  '), 'acme ltd');
  });
  it('tolerates null/undefined', () => {
    assert.equal(normaliseName(null), '');
    assert.equal(normaliseName(undefined), '');
  });
});

describe('canonicalName', () => {
  it('folds a legal suffix so "Beers LTD" matches "Beers"', () => {
    assert.equal(canonicalName('Beers LTD'), canonicalName('Beers'));
  });
  it('folds a leading "The"', () => {
    assert.equal(canonicalName('The Counting House'), canonicalName('Counting House'));
  });
  it('folds & vs and together with a suffix', () => {
    assert.equal(
      canonicalName('Titan Land & Building'),
      canonicalName('Titan Land and Building Ltd'),
    );
  });
  it('folds punctuation (R H Binks & Sons / R H Binks and Sons)', () => {
    assert.equal(canonicalName('R H Binks & Sons'), canonicalName('R H Binks and Sons'));
  });
  it('keeps genuinely different suppliers distinct (does not strip "Services"/"Group")', () => {
    assert.notEqual(canonicalName('Smith Services'), canonicalName('Smith'));
    assert.notEqual(canonicalName('B&M'), canonicalName('B&Q'));
  });
  it('tolerates null/undefined', () => {
    assert.equal(canonicalName(null), '');
  });
});

describe('computeMissingCorrespondents', () => {
  it('creates suppliers with no matching correspondent', () => {
    const out = computeMissingCorrespondents(['Acme Ltd', 'Beta Co'], ['Acme Ltd']);
    assert.deepEqual(out, ['Beta Co']);
  });

  it('does not twin a suffix-less correspondent (KashFlow "Beers LTD" vs Paperless "Beers")', () => {
    const out = computeMissingCorrespondents(['Beers LTD'], ['Beers']);
    assert.deepEqual(out, []);
  });

  it('does not twin across "The", & vs and, or a legal suffix', () => {
    assert.deepEqual(
      computeMissingCorrespondents(
        ['The Counting House', 'Titan Land and Building Ltd', 'Secure Bolts LTD'],
        ['Counting House', 'Titan Land & Building', 'Secure Bolts'],
      ),
      [],
    );
  });

  it('still creates a genuinely distinct supplier that only looks similar', () => {
    const out = computeMissingCorrespondents(['B&Q'], ['B&M']);
    assert.deepEqual(out, ['B&Q']);
  });

  it('dedupes suffix variants within one supplier list', () => {
    const out = computeMissingCorrespondents(['Beers', 'Beers Ltd'], []);
    assert.deepEqual(out, ['Beers']); // first spelling wins, created once
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
