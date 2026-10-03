import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import securityEvent from '../mongoose/models/mongoose/INTERNAL/securityEvent.js';

/**
 * createdAt must be indexed once, by the TTL index. A second, plain index on
 * the same key has the same name (createdAt_1), so whichever MongoDB created
 * first won, and the 400-day expiry could silently never apply.
 */
describe('securityEvent indexes', () => {
  const schema = securityEvent.schema || securityEvent;

  it('indexes createdAt alone exactly once, with the expiry', () => {
    const single = schema.indexes().filter(([keys]) => Object.keys(keys).length === 1 && 'createdAt' in keys);
    assert.equal(single.length, 1);
    assert.equal(single[0][1].expireAfterSeconds, 400 * 24 * 60 * 60);
    assert.notEqual(schema.path('createdAt').options.index, true);
  });
});
