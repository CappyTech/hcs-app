#!/usr/bin/env node
/**
 * Paperless migration H7: backfill state and notification history for every
 * document hcs-app already holds, from its Paperless tags.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed. Run the
 * dry run first, read the report, then run it again with --apply.
 *
 * Idempotent: a second --apply run changes nothing. Paperless is only read
 * (through the copy hcs-app already holds), never written, and nothing is
 * emailed or posted. Rules and decisions: PAPERLESS-MIGRATION.md H7 and 0a.
 *
 * Usage (inside the hcs-app container):
 *   node scripts/paperless-backfill.js                 # dry run
 *   node scripts/paperless-backfill.js --grab          # refresh from Paperless first, then dry run
 *   node scripts/paperless-backfill.js --apply         # write
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import backfill from '../mongoose/services/paperless/backfillService.js';
import grab from '../mongoose/services/grabServicePaperless.js';

const APPLY = process.argv.includes('--apply');
const GRAB = process.argv.includes('--grab');
const tag = APPLY ? '[backfill]' : '[dry-run]';
const log = (...args) => console.log(tag, ...args);

async function main() {
  await mdb.connect();
  const { OcrDocument, NotificationLog } = mdb.PAPERLESS || {};
  if (!OcrDocument || !NotificationLog) throw new Error('PAPERLESS models not loaded');

  if (GRAB) {
    log('Refreshing every document from Paperless first (full grab)…');
    const g = await grab.grabPaperlessOCR({ since: null });
    log(`Grab done: processed=${g.processed} skipped=${g.skipped} failed=${g.failed}`);
  }

  const summary = await backfill.runBackfill({ OcrDocument, NotificationLog, apply: APPLY, log });
  console.log(`\n${backfill.formatSummary(summary)}\n`);
  if (!APPLY) log('Nothing was written. Re-run with --apply to write.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(tag, 'failed:', err.message);
    process.exit(1);
  });
