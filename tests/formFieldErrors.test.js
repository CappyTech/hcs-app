import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import mongoose from 'mongoose';
import ejs from 'ejs';
import { describeValidationError } from '../mongoose/controllers/CRUDController.js';

/**
 * Field-level validation messages (WCAG 3.3.1 / 3.3.3): a rejected form comes
 * back with each problem beside its field, tied to the input, and listed in a
 * summary that links to the field.
 */

const VIEWS = path.resolve('mongoose/views/tailwindcss');

const validationErrorFor = (schemaDef, doc) => {
  const Model = mongoose.model(`A11yForm${Math.random().toString(36).slice(2)}`, new mongoose.Schema(schemaDef));
  return new Model(doc).validateSync();
};

describe('describeValidationError', () => {
  it('words a missing required field with its label', () => {
    const err = validationErrorFor({ name: { type: String, required: true } }, {});
    const { errors, fieldErrors } = describeValidationError(err, { name: { label: 'Name' } });
    assert.deepEqual(fieldErrors, { name: 'Name is required.' });
    assert.deepEqual(errors, ['Name is required.']);
  });

  it('words a value that is not the right type', () => {
    const err = validationErrorFor({ hireDate: Date }, { hireDate: 'not a date' });
    const { fieldErrors } = describeValidationError(err, { hireDate: { label: 'Hire Date' } });
    assert.match(fieldErrors.hireDate, /^Hire Date isn't a valid date\./);
  });

  it('keys nested fields by their path and drops a group prefix from the label', () => {
    const err = validationErrorFor({ contract: { startDate: { type: Date, required: true } } }, {});
    const { fieldErrors } = describeValidationError(err, { 'contract.startDate': { label: 'Contract.Start Date' } });
    assert.deepEqual(fieldErrors, { 'contract.startDate': 'Start Date is required.' });
  });
});

const renderField = (fieldErrors) => ejs.renderFile(path.join(VIEWS, 'partials/_formField.ejs'), {
  key: 'name', field: { label: 'Name', type: 'String', required: true },
  formData: {}, referenceData: {}, readOnly: false, showTips: true, config: {}, groupPrefix: null,
  fieldErrors,
});

describe('_formField error message', () => {
  it('shows the message under the input and links it with aria-describedby and aria-invalid', async () => {
    const html = await renderField({ name: 'Name is required.' });
    assert.match(html, /<input[^>]*id="name"[^>]*aria-invalid="true"[^>]*aria-describedby="name-error"/s);
    assert.match(html, /<p id="name-error"[^>]*>[\s\S]*Name is required\./);
  });

  it('adds nothing when the field has no error', async () => {
    const html = await renderField({});
    assert.doesNotMatch(html, /aria-invalid|name-error/);
  });
});
