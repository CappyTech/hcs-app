import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import { unlinkedFilter } from '../mongoose/services/dashboardCountService.js';

/**
 * The OCR Documents tile counted every document with no KashFlow link, so its
 * "unlinked" badge included credit notes, supplier statements and the
 * "original/multiple invoice one pdf" originals — none of which ever get a
 * link. It now counts the same set as Unlinked on /overview/documents.
 */
const PI = { id: 1, name: 'Purchase Invoice' };
const doc = (paperlessId, extra = {}) => ({
  paperlessId, title: `doc ${paperlessId}`, documentType: PI, tags: [], deletedInPaperlessAt: null,
  creditNote: false, processingState: 'awaiting_entry', excludedReason: null, kashflowPurchaseId: null, ...extra,
});
const ids = (rows) => rows.filter(sift(unlinkedFilter())).map((d) => d.paperlessId);

describe('OCR Documents unlinked tile', () => {
  it('counts only purchase invoices that still need a KashFlow link', () => {
    const rows = [
      doc(1),
      doc(2, { kashflowPurchaseId: 99 }),                                      // linked
      doc(3, { documentType: { id: 2, name: 'Supplier Statement' } }),         // statement
      doc(4, { tags: [{ id: 8, name: 'credit/refund' }] }),                    // credit tag
      doc(5, { creditNote: true, processingState: 'manual_kashflow' }),        // flagged credit note
      doc(6, { title: 'Credit note 12' }),                                     // credit in title
      doc(7, { tags: [{ id: 4, name: 'original/multiple invoice one pdf' }] }), // original PDF
      doc(8, { excludedReason: 'manually_added' }),                            // excluded
      doc(9, { deletedInPaperlessAt: new Date() }),                            // gone from Paperless
    ];
    assert.deepEqual(ids(rows), [1]);
  });

  it('the tile and the list it links to use the same filter', () => {
    const svc = fs.readFileSync(path.resolve('mongoose/services/dashboardCountService.js'), 'utf8');
    assert.match(svc, /countDocuments\(unlinkedFilter\(\)\)/);
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    assert.match(ctrl, /if \(onlyUnlinked\) \{[\s\S]{0,120}unlinkedFilter\(\)/);
  });
});
