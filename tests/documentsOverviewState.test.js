import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import { KF_ELIGIBLE_MATCH, NEVER_SENT_ELIGIBLE_MATCH } from '../mongoose/services/documentsOverviewService.js';

/** /overview/documents agrees with what hcs-app knows about each document (6.55.5). */
const PI = { id: 1, name: 'Purchase Invoice' };
const doc = (paperlessId, extra = {}) => ({
  paperlessId, title: `doc ${paperlessId}`, documentType: PI, tags: [], deletedInPaperlessAt: null,
  creditNote: false, processingState: 'awaiting_entry', excludedReason: null, kashflowPurchaseId: null, lastSentAt: null, ...extra,
});
const ids = (filter, rows) => rows.filter(sift(filter)).map((d) => d.paperlessId);

describe('documents overview', () => {
  const rows = [
    doc(1),
    doc(1158, { creditNote: true, processingState: 'manual_kashflow' }), // flagged credit note, no Paperless tag
    doc(1139, { processingState: 'sent', kashflowPurchaseId: 153542300 }), // linked with Match Purchase, never sent from here
    doc(4, { excludedReason: 'manually_added' }),
    doc(5, { lastSentAt: new Date(), kashflowPurchaseId: 1 }),
  ];

  it('Never Sent leaves out credit notes, excluded invoices and anything already linked to a purchase', () => {
    assert.deepEqual(ids({ lastSentAt: null, kashflowPurchaseId: null, ...NEVER_SENT_ELIGIBLE_MATCH }, rows), [1]);
  });

  it('Unlinked leaves out credit notes and excluded invoices', () => {
    assert.deepEqual(ids({ kashflowPurchaseId: null, ...KF_ELIGIBLE_MATCH }, rows), [1]);
  });

  it("Fix All leaves a purchase it can't find alone, and never takes a link another document holds", () => {
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    const repair = ctrl.slice(ctrl.indexOf('export const repairDrift'), ctrl.indexOf('export const syncPaperlessFields'));
    assert.match(repair, /purchaseHeldElsewhere\(OcrDocument, cfId, doc\.paperlessId\)/);
    // Clears only on positive evidence the purchase was deleted
    assert.match(repair, /else if \(!activePurchase && !deletedPurchase\) \{[\s\S]*?left as it is/);
    assert.ok(repair.indexOf('!activePurchase && !deletedPurchase') < repair.indexOf('clearPaperlessKashFlowFields'));
  });
});
