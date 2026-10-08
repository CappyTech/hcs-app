import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sift from 'sift';
import { matchSearchFilter } from '../mongoose/controllers/paperlessController.js';

/** The purchase search on Match Purchase. Made-up purchases. */

const PURCHASES = [
  { Number: 1001, SupplierName: 'Acme Timber', SupplierReference: 'I 5550001' },
  { Number: 1002, SupplierName: 'Acme Timber', SupplierReference: 'I5550002' },
  { Number: 1003, SupplierName: 'Bolt Supplies', SupplierReference: '7781' },
  { Number: 7781, SupplierName: 'Bolt Supplies', SupplierReference: 'B-1' },
];
const find = (q) => PURCHASES.filter(sift(matchSearchFilter(q))).map((p) => p.Number);

describe('Match Purchase search', () => {
  it('finds a reference whatever its spacing (#216)', () => {
    assert.deepEqual(find('I5550001'), [1001]);
    assert.deepEqual(find('I 5550002'), [1002]);
    assert.deepEqual(find('i5550001'), [1001]);
  });

  it('a number finds the purchase number and references', () => {
    assert.deepEqual(find('7781'), [1003, 7781]);
    assert.deepEqual(find('5550001'), [1001]);
  });

  it('still finds by supplier name', () => {
    assert.deepEqual(find('acme'), [1001, 1002]);
  });

  it("treats regex characters as text", () => {
    assert.deepEqual(find('B-1'), [7781]);
    assert.doesNotThrow(() => matchSearchFilter('a(b'));
  });
});
