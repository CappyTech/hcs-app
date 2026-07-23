import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import __kashflowSendClaimService from '../mongoose/services/paperless/kashflowSendClaimService.js';

const { claimSend, releaseSend, SEND_CLAIM_STALE_MS } =
  __kashflowSendClaimService;

// Chainable mock matching .findOneAndUpdate(...).select(...).lean() and
// .findOne(...).select(...).lean()
function mockModel({ claimResult = null, doc = null } = {}) {
  const calls = { findOneAndUpdate: [], findOne: [], updateOne: [] };
  return {
    calls,
    findOneAndUpdate: (filter, update, opts) => {
      calls.findOneAndUpdate.push({ filter, update, opts });
      return { select: () => ({ lean: async () => claimResult }) };
    },
    findOne: (filter) => {
      calls.findOne.push({ filter });
      return { select: () => ({ lean: async () => doc }) };
    },
    updateOne: async (filter, update) => {
      calls.updateOne.push({ filter, update });
      return { modifiedCount: 1 };
    }
  };
}

describe('claimSend', () => {
  it('wins the claim and sets kfSendLockedAt', async () => {
    const model = mockModel({ claimResult: { _id: 'x' } });
    const result = await claimSend(model, 42);

    assert.equal(result.ok, true);
    assert.equal(model.calls.findOneAndUpdate.length, 1);
    const { filter, update } = model.calls.findOneAndUpdate[0];
    assert.equal(filter.paperlessId, 42);
    assert.ok(update.$set.kfSendLockedAt instanceof Date);
    // No diagnostic read needed on success
    assert.equal(model.calls.findOne.length, 0);
  });

  it('claim filter excludes documents already linked with a 201', async () => {
    const model = mockModel({ claimResult: { _id: 'x' } });
    await claimSend(model, 42);
    const { filter } = model.calls.findOneAndUpdate[0];
    assert.deepEqual(filter.$nor, [{ kashflowPurchaseId: { $ne: null }, lastSendStatus: 201 }]);
  });

  it('claim filter allows takeover of a stale claim', async () => {
    const model = mockModel({ claimResult: { _id: 'x' } });
    const before = Date.now() - SEND_CLAIM_STALE_MS;
    await claimSend(model, 42);
    const { filter } = model.calls.findOneAndUpdate[0];

    const staleCond = filter.$or.find(c => c.kfSendLockedAt && c.kfSendLockedAt.$lt);
    assert.ok(staleCond, 'stale takeover condition missing');
    const cutoff = staleCond.kfSendLockedAt.$lt.getTime();
    assert.ok(cutoff >= before && cutoff <= Date.now() - SEND_CLAIM_STALE_MS + 5000,
      'stale cutoff should be ~SEND_CLAIM_STALE_MS ago');
    // And unlocked documents are claimable
    assert.ok(filter.$or.some(c => c.kfSendLockedAt === null));
  });

  it('reports already-linked with the purchase id', async () => {
    const model = mockModel({
      claimResult: null,
      doc: { kashflowPurchaseId: 9876, lastSendStatus: 201 }
    });
    const result = await claimSend(model, 42);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-linked');
    assert.equal(result.purchaseId, 9876);
    assert.match(result.message, /#9876/);
  });

  it('reports in-progress when another send holds a live claim', async () => {
    const model = mockModel({
      claimResult: null,
      doc: { kashflowPurchaseId: null, lastSendStatus: null, kfSendLockedAt: new Date() }
    });
    const result = await claimSend(model, 42);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'in-progress');
  });

  it('reports not-found for an unknown document', async () => {
    const model = mockModel({ claimResult: null, doc: null });
    const result = await claimSend(model, 42);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
  });

  it('a failed send (non-201) does not permanently block re-claiming', async () => {
    // Document has a purchase id from an earlier attempt but lastSendStatus 500:
    // the $nor only excludes id + 201, so the claim filter still matches.
    const model = mockModel({ claimResult: { _id: 'x' } });
    const result = await claimSend(model, 42);
    assert.equal(result.ok, true);
    const { filter } = model.calls.findOneAndUpdate[0];
    // Sanity: the only exclusion is the id+201 combination
    assert.equal(filter.$nor.length, 1);
  });
});

describe('releaseSend', () => {
  it('clears kfSendLockedAt', async () => {
    const model = mockModel();
    await releaseSend(model, 42);
    assert.equal(model.calls.updateOne.length, 1);
    assert.deepEqual(model.calls.updateOne[0].filter, { paperlessId: 42 });
    assert.deepEqual(model.calls.updateOne[0].update, { $set: { kfSendLockedAt: null } });
  });

  it('never throws — the stale timeout is the fallback', async () => {
    const model = {
      updateOne: async () => { throw new Error('connection lost'); }
    };
    await assert.doesNotReject(() => releaseSend(model, 42));
  });
});
