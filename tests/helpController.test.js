import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The help articles are one large hand-edited object; a stray quote breaks the
// whole app at startup, and nothing else imports this file in the tests.
describe('helpController', () => {
  it('loads', async () => {
    const mod = await import('../mongoose/controllers/helpController.js');
    assert.ok(mod.default || Object.keys(mod).length);
  });
});
