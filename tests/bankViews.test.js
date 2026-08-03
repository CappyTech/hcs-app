import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

/**
 * Renders every bank view twice — once with full data, once with the bare
 * minimum — mirroring tests/readViews.test.js. Catches template syntax errors
 * and unguarded property access with no browser and no database.
 *
 * Also asserts the CSP rules from docs/UI-GUIDELINES.md, because Helmet
 * enforces them at runtime and a stray <script> would only surface as a
 * silently broken page in production.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = path.join(ROOT, 'mongoose/views/tailwindcss/bank');

/* Locals that layout.ejs normally supplies via res.locals. */
const baseLocals = {
  title: 'Bank',
  csrfToken: 'test-csrf-token',
  user: { role: 'admin', name: 'Test Admin' },
  slimDateTime: (d) => (d ? new Date(d).toISOString().slice(0, 10) : ''),
  formatCurrency: (n) => `£${(Number(n) || 0).toFixed(2)}`,
};

const render = (view, locals) => ejs.renderFile(
  path.join(VIEWS, `${view}.ejs`),
  { ...baseLocals, ...locals },
  { async: false },
);

/* ── fixtures ─────────────────────────────────────────────────────── */

const fullMatch = {
  uuid: 'm-1',
  status: 'suggested',
  integrity: 'ok',
  matchType: 'document',
  confidence: 100,
  reasons: ['KashFlow links this line to purchase 35'],
  documents: [
    { kind: 'purchase', kfId: 900, kfNumber: 35, docKey: 'purchase:900', allocatedAmount: 16.46, docGross: 16.46, partyName: 'Screwfix' },
  ],
  totals: { bankTotal: -16.46, documentTotal: 16.46, variance: 0 },
  reviewedByName: 'Test Admin',
  reviewedAt: new Date(),
  createdAt: new Date(),
};

const fullLine = {
  Id: 47766903, AccountId: 611594, Date: new Date(), EntityName: 'purchase',
  ResourceNumber: 35, PaidIn: 0, PaidOut: 16.46, Comment: 'Purchase - SCRE01',
  Type: 'Purchase', SupplierName: 'Screwfix', Reconciled: false, amount: -16.46,
};

const account = {
  accountId: 611594, accountName: 'Heron Constructive Solutions LTD', known: true,
  isArchived: false, transactionCount: 7908, confirmedCount: 438,
  outstandingCount: 7470, progress: 6, oldest: new Date(), newest: new Date(),
};

/* Full and minimal locals for each view. */
const CASES = {
  index: {
    full: {
      accounts: [account, { ...account, accountId: 999, accountName: 'Unknown account', known: false, isArchived: true }],
      totals: { transactions: 13429, confirmed: 438, suggested: 120, rejected: 3, outstanding: 12991, drifted: 2, progress: 3 },
      recentSignOffs: [{ uuid: 's-1', accountId: 611594, accountName: 'Main', periodStart: new Date(), periodEnd: new Date(), status: 'signed', signedByName: 'A', signedAt: new Date(), variance: 0 }],
    },
    minimal: { accounts: [], totals: {}, recentSignOffs: [] },
  },
  account: {
    full: {
      account, filters: { state: 'outstanding', search: 'screwfix', from: '2025-01-01', to: '2025-12-31', entity: 'purchase', pageSize: 50 },
      rows: [{ ...fullLine, strategy: 'direct', match: fullMatch },
        { ...fullLine, Id: 2, EntityName: 'banktransaction', strategy: 'unlinked', match: null }],
      total: 2, page: 1, pageSize: 50, pageCount: 3,
    },
    minimal: {
      account: { accountId: 1, accountName: 'X', known: false },
      filters: { state: 'all', search: '', from: '', to: '', entity: '', pageSize: 50 },
      rows: [], total: 0, page: 1, pageSize: 50, pageCount: 1,
    },
  },
  match: {
    full: {
      line: fullLine, account,
      resolution: { resolved: true, strategy: 'direct', documents: fullMatch.documents, reasons: ['ok'], problems: ['Bank amount 960.00 differs from purchase gross 1200.00'] },
      matches: [fullMatch, { ...fullMatch, uuid: 'm-0', status: 'rejected', rejectedReason: 'wrong supplier' }],
      current: fullMatch,
    },
    minimal: {
      line: { Id: 1, amount: 0 }, account: null,
      resolution: { resolved: false, strategy: 'unlinked', documents: [], reasons: [], problems: [] },
      matches: [], current: null,
    },
  },
  signoff: {
    full: {
      accounts: [account],
      signOffs: [
        { uuid: 's-1', accountId: 611594, accountName: 'Main', periodStart: new Date(), periodEnd: new Date(), matchedCount: 40, unmatchedCount: 2, variance: -10, status: 'signed', signedByName: 'A', signedAt: new Date() },
        { uuid: 's-2', accountId: 611594, accountName: 'Main', periodStart: new Date(), periodEnd: new Date(), matchedCount: 1, unmatchedCount: 0, variance: 0, status: 'reopened', signedByName: 'A', signedAt: new Date(), reopenedByName: 'B', reopenReason: 'restated' },
      ],
    },
    minimal: { accounts: [], signOffs: [] },
  },
  exceptions: {
    full: {
      drifted: [{ uuid: 'm-9', documents: fullMatch.documents, driftFlags: ['gross changed'], reviewedByName: 'A', bankLines: [{ bankTransactionId: 1 }] }],
      unresolvable: [{ line: fullLine, problems: ['purchase 35 no longer exists'], resolved: false }],
      staleUnmatched: [fullLine],
      kfDisagreement: { kfOnly: [fullLine], usOnly: [fullLine] },
      staleCutoff: new Date(),
    },
    minimal: {
      drifted: [], unresolvable: [], staleUnmatched: [],
      kfDisagreement: { kfOnly: [], usOnly: [] }, staleCutoff: new Date(),
    },
  },
};

/* ── tests ────────────────────────────────────────────────────────── */

describe('bank views', () => {
  for (const [view, cases] of Object.entries(CASES)) {
    describe(view, () => {
      it('renders with full data', async () => {
        const html = await render(view, cases.full);
        assert.ok(html.length > 100, 'rendered suspiciously little');
      });

      it('renders with minimal data', async () => {
        // Empty states must not throw on absent arrays or null objects.
        const html = await render(view, cases.minimal);
        assert.ok(html.length > 50);
      });

      it('contains no inline script, style or event handler', async () => {
        // Helmet's CSP blocks all three; a violation only shows up as a
        // silently broken page in production.
        const html = await render(view, cases.full);
        assert.ok(!/<script/i.test(html), 'contains a <script> tag');
        assert.ok(!/<style/i.test(html), 'contains a <style> tag');
        assert.ok(!/\son(click|change|submit|load|input)\s*=/i.test(html), 'contains an inline event handler');
        assert.ok(!/\b(fetch|XMLHttpRequest|axios)\s*\(/.test(html), 'contains a browser network call');
      });

      it('is a fragment, not a full page', async () => {
        const html = await render(view, cases.full);
        for (const tag of ['<html', '<head', '<body', '<nav']) {
          assert.ok(!html.toLowerCase().includes(tag), `contains ${tag}`);
        }
      });
    });
  }

  it('includes a CSRF token in every mutating form', async () => {
    for (const [view, cases] of Object.entries(CASES)) {
      const html = await render(view, cases.full);
      const postForms = html.match(/<form[^>]*method=["']POST["'][^>]*>/gi) || [];
      if (!postForms.length) continue;

      const tokens = html.match(/name=["']_csrf["']/g) || [];
      assert.ok(
        tokens.length >= postForms.length,
        `${view}: ${postForms.length} POST forms but only ${tokens.length} CSRF tokens`,
      );
    }
  });

  it('has a view for every render call in the controller', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'mongoose/controllers/bankController.js'), 'utf8');
    const referenced = [...src.matchAll(/VIEW\('([^']+)'\)/g)].map(m => m[1]);
    assert.ok(referenced.length >= 5, `only found ${referenced.length} view references`);
    for (const view of referenced) {
      assert.ok(fs.existsSync(path.join(VIEWS, `${view}.ejs`)), `controller renders missing view ${view}`);
    }
  });

  it('renders the status badge for every match state', async () => {
    const partial = path.join(VIEWS, 'partials/_match-badge.ejs');
    for (const status of ['suggested', 'confirmed', 'rejected', 'superseded']) {
      const html = await ejs.renderFile(partial, { match: { status, integrity: 'ok' } }, { async: false });
      assert.match(html, new RegExp(status));
    }
    // A confirmed-but-drifted match must not read as a clean confirmation.
    const drifted = await ejs.renderFile(partial, { match: { status: 'confirmed', integrity: 'drifted' } }, { async: false });
    assert.match(drifted, /drifted/);
    // And a line with no match at all still renders something.
    const none = await ejs.renderFile(partial, { match: null, strategy: 'unlinked' }, { async: false });
    assert.match(none, /no KashFlow link/);
  });
});
