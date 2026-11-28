import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import mongoose from 'mongoose';
import ejs from 'ejs';

/**
 * A read-only reference whose record was deleted showed the ObjectId's raw
 * bytes ("buffer: j…"). It now says the record was not found.
 */
const VIEWS = path.resolve('mongoose/views/tailwindcss');
const id = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();

const render = (value, referenceData, isArray = false) => ejs.renderFile(path.join(VIEWS, 'partials/_formField.ejs'), {
  key: 'locationId', field: { label: 'Location', type: isArray ? 'Array' : 'ObjectId', ref: 'location', isArray },
  formData: { locationId: value }, referenceData, readOnly: true, showTips: false, config: {}, groupPrefix: null,
});

describe('_formField read-only reference', () => {
  it('shows the name when the record exists', async () => {
    const html = await render(id, { locationId: [{ _id: id, name: 'Yard' }] });
    assert.match(html, /Yard/);
  });

  it('says not found for a deleted record instead of the id bytes', async () => {
    const html = await render(id, { locationId: [{ _id: other, name: 'Yard' }] });
    assert.match(html, /Not found \(deleted\)/);
    assert.doesNotMatch(html, /buffer/);
  });

  it('marks deleted items in a list of references', async () => {
    const html = await render([id, other], { locationId: [{ _id: other, name: 'Yard' }] }, true);
    assert.match(html, /Not found \(deleted\), Yard|Not found \(deleted\)[\s\S]*Yard/);
  });

  it('shows the id, not its bytes, when there is no reference data', async () => {
    const html = await render(id, {});
    assert.match(html, new RegExp(String(id)));
    assert.doesNotMatch(html, /buffer/);
  });
});
