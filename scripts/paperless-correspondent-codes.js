#!/usr/bin/env node
/**
 * Name Paperless correspondents "<Name> (<Code>)" after their KashFlow
 * supplier, so a glance shows which come from KashFlow and which were made by
 * hand. Renames hand-made correspondents that match a supplier (exactly, or
 * with "Ltd", "&" and punctuation folded), creates any that are missing, and
 * renames coded ones whose supplier was renamed in KashFlow.
 *
 * DRY RUN BY DEFAULT. Nothing is changed unless --apply is passed. Read the
 * dry run first: every rename is listed, and a correspondent two suppliers
 * could both claim is listed as ambiguous and left alone.
 *
 * Documents keep their correspondent (it's the same one, renamed), and the
 * copy hcs-app holds of each renamed name is updated too. Idempotent: a second
 * --apply changes nothing. Never deletes anything.
 *
 * Usage (inside the hcs-app container):
 *   node scripts/paperless-correspondent-codes.js            # dry run
 *   node scripts/paperless-correspondent-codes.js --apply    # rename and create
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import sync from '../mongoose/services/paperless/supplierCorrespondentSyncService.js';

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '[codes]' : '[dry-run]';
const log = (...args) => console.log(tag, ...args);

async function main() {
  const s = await sync.syncSuppliersToCorrespondents({ dryRun: !APPLY, renameMatched: true });
  if (s.skippedRun) throw new Error('The correspondent sync job is running; try again in a minute.');
  const { plan } = s;

  const matched = plan.rename.filter((r) => r.why === 'matched');
  const kashflow = plan.rename.filter((r) => r.why === 'kashflow');
  console.log(`\nSuppliers: ${s.suppliers}`);
  console.log(`Already "<Name> (<Code>)": ${plan.inStep}`);
  console.log(`Hand-made, renamed to carry the code: ${matched.length}`);
  for (const r of matched) console.log(`  #${r.id}  "${r.from}"  →  "${r.to}"`);
  console.log(`Coded, renamed because KashFlow's name changed: ${kashflow.length}`);
  for (const r of kashflow) console.log(`  #${r.id}  "${r.from}"  →  "${r.to}"`);
  console.log(`Created: ${plan.create.length}`);
  for (const n of plan.create) console.log(`  "${n}"`);
  console.log(`Ambiguous, left alone (rename by hand, or assign the supplier on the entry screen): ${plan.ambiguous.length}`);
  for (const a of plan.ambiguous) console.log(`  #${a.id}  "${a.name}"  could be ${a.codes.join(' or ')}`);

  if (!APPLY) {
    log('\nNothing was changed. Re-run with --apply to rename and create.');
    return;
  }
  // hcs-app's copy of each document's correspondent name
  await mdb.connect();
  const { OcrDocument } = mdb.PAPERLESS || {};
  let docs = 0;
  if (OcrDocument) {
    for (const r of plan.rename) {
      const res = await OcrDocument.updateMany({ 'correspondent.id': r.id }, { $set: { 'correspondent.name': r.to } });
      docs += res.modifiedCount || 0;
    }
  }
  console.log(`\nRenamed ${s.renamed}, created ${s.created}, failed ${s.failed}. Updated the name on ${docs} documents in hcs-app.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(tag, 'failed:', err.message);
    process.exit(1);
  });
