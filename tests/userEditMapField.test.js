import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import crudConfig from '../mongoose/config/CRUDControllerConfig.js';

/**
 * user.customPermissions.models is a Mongoose Map. When the generic edit form
 * rendered it as a text input it posted back "[object Object]", and Mongoose's
 * Map cast threw "Iterator value [ is not an entry object" — a 500 on every
 * user edit. The form must never render it, and the generic update must never
 * accept customPermissions from the body.
 */
describe('user edit form and customPermissions', () => {
  const cfg = crudConfig.user;

  it('hides the customPermissions Map from the generic form', () => {
    assert.ok(cfg.hideFields.includes('customPermissions.models'));
  });

  it('drops customPermissions from the generic update body', () => {
    assert.ok(cfg.bodyDeny.includes('customPermissions'));
  });
});
