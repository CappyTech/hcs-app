#!/usr/bin/env node
/**
 * Resolution harness — read-only, developer tool, not wired into the app.
 *
 * Runs bankLinkService across every bank transaction in the database and
 * reports how many resolve, how many agree on amount, and every distinct
 * failure. Nothing is written anywhere, and KashFlow is never contacted.
 *
 * Usage:
 *   MONGO_DB_NAME=rest-kashflowdb-recontest node scripts/verify-bank-links.js
 *   node scripts/verify-bank-links.js --limit 500
 */
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import { resolveBankLine, classify, signedAmount, amountsAgree, expectedAllocation } from '../mongoose/services/bankLinkService.js';

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 0;

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a';
}

async function main() {
  await mdb.connect();
  const BankTransaction = mdb.REST?.bankTransaction;
  if (!BankTransaction) throw new Error('bankTransaction model not loaded');

  const query = BankTransaction.find({}).select(
    'Id AccountId Date EntityName ResourceNumber PaidIn PaidOut Comment Type Reconciled',
  ).lean();
  if (LIMIT) query.limit(LIMIT);
  const lines = await query;

  const byStrategy = {};
  const problems = new Map();
  let resolved = 0;
  let amountAgreed = 0;
  let amountChecked = 0;

  for (const tx of lines) {
    const { strategy } = classify(tx);
    byStrategy[strategy] = byStrategy[strategy] || { total: 0, resolved: 0, failed: 0, flagged: 0 };
    byStrategy[strategy].total += 1;

    const r = await resolveBankLine(tx);
    if (r.resolved) {
      resolved += 1;
      byStrategy[strategy].resolved += 1;
    } else if (strategy !== 'unlinked') {
      byStrategy[strategy].failed += 1;
    }

    if (r.problems.length) {
      byStrategy[strategy].flagged += 1;
      for (const p of r.problems) {
        // Collapse the varying numbers so distinct *kinds* of problem group.
        const key = p.replace(/-?\d+(\.\d+)?/g, 'N');
        const entry = problems.get(key) || { count: 0, example: p, ids: [] };
        entry.count += 1;
        if (entry.ids.length < 5) entry.ids.push(tx.Id);
        problems.set(key, entry);
      }
    }

    if (r.resolved && r.documents.length) {
      amountChecked += 1;
      const allocated = r.documents.reduce((s, d) => s + d.allocatedAmount, 0);
      const kind = r.documents[0].kind;
      if (amountsAgree(allocated, expectedAllocation(signedAmount(tx), kind))) amountAgreed += 1;
    }
  }

  const linked = lines.length - (byStrategy.unlinked?.total || 0);

  console.log('\n=== BANK LINK RESOLUTION ===');
  console.log(`bank transactions examined : ${lines.length}`);
  console.log(`carrying a KashFlow link   : ${linked} (${pct(linked, lines.length)})`);
  console.log(`resolved to document(s)    : ${resolved} (${pct(resolved, linked)} of linked)`);
  console.log(`amount agreed              : ${amountAgreed} of ${amountChecked} (${pct(amountAgreed, amountChecked)})`);

  console.log('\n--- by strategy ---');
  for (const [strategy, s] of Object.entries(byStrategy).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${strategy.padEnd(10)} total=${String(s.total).padStart(6)}  resolved=${String(s.resolved).padStart(6)}  failed=${String(s.failed).padStart(4)}  flagged=${String(s.flagged).padStart(5)}`,
    );
  }

  console.log('\n--- distinct problems ---');
  if (!problems.size) {
    console.log('  (none)');
  } else {
    for (const [, p] of [...problems.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${String(p.count).padStart(6)}x  ${p.example}`);
      console.log(`          e.g. bank tx ${p.ids.join(', ')}`);
    }
  }

  const gate = linked ? resolved / linked : 1;
  console.log(`\nGATE: >=99% of linked lines resolve -> ${(gate * 100).toFixed(2)}% ${gate >= 0.99 ? 'PASS' : 'FAIL'}`);
  process.exitCode = gate >= 0.99 ? 0 : 1;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await mdb.disconnect?.().catch(() => {}); process.exit(process.exitCode || 0); });
