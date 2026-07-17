const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const v = require('../mongoose/services/configValidatorService');

const MODELS = ['user', 'employee', 'supplier', 'assignment'];

describe('configValidatorService.validate', () => {
  it('passes clean config', () => {
    const warnings = v.validate({
      listConfig: { employee: { title: 'Employees', hideFields: ['_id'], department: ['hr'] } },
      crudConfig: { employee: { readOnly: ['uuid'], validators: {} } },
      modelNames: MODELS,
    });
    assert.deepEqual(warnings, []);
  });

  it('flags an unknown option key (typo)', () => {
    const warnings = v.validate({
      listConfig: { employee: { hideFileds: ['_id'] } }, // typo
      crudConfig: {},
      modelNames: MODELS,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unknown option "hideFileds"/);
  });

  it('flags a config entry with no backing model', () => {
    const warnings = v.validate({
      listConfig: {},
      crudConfig: { contractAssignment: { readOnly: ['uuid'] } },
      modelNames: MODELS,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"contractAssignment" does not match any registered model/);
  });

  it('accepts plural/singular and case variants', () => {
    const warnings = v.validate({
      listConfig: { Employees: { title: 'x' }, supplier: { title: 'y' } },
      crudConfig: {},
      modelNames: ['employee', 'supplier'],
    });
    assert.deepEqual(warnings, []);
  });

  it('resolves aliases via aliasOf, not the entry name', () => {
    const warnings = v.validate({
      listConfig: { subcontractor: { aliasOf: 'supplier', title: 'Subbies' } },
      crudConfig: {},
      modelNames: ['supplier'],
    });
    assert.deepEqual(warnings, []);
  });

  it('exempts the reserved "default" block from the model check but still checks its keys', () => {
    const clean = v.validate({ listConfig: {}, crudConfig: { default: { readOnly: ['uuid'] } }, modelNames: MODELS });
    assert.deepEqual(clean, []);
    const typo = v.validate({ listConfig: {}, crudConfig: { default: { readOnlyy: ['uuid'] } }, modelNames: MODELS });
    assert.equal(typo.length, 1);
    assert.match(typo[0], /unknown option "readOnlyy"/);
  });
});
