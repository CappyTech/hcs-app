import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singularTitle } from '../mongoose/controllers/CRUDController.js';

/** Page titles name one record in the singular (WCAG 2.4.2): "Create Employee", not "Create Employees". */
describe('singularTitle', () => {
  const cases = {
    Employees: 'Employee',
    'Holiday Requests': 'Holiday Request',
    Policies: 'Policy',
    Addresses: 'Address',
    Batches: 'Batch',
    Contract: 'Contract',
    CIS: 'CIS',
    Status: 'Status',
    Analysis: 'Analysis',
  };
  for (const [plural, single] of Object.entries(cases)) {
    it(`${plural} → ${single}`, () => assert.equal(singularTitle(plural), single));
  }
});
