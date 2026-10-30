import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.PAPERLESS_URL = 'mock';

import mailRules from '../mongoose/services/paperless/mailRuleService.js';
import mockPaperless from '../mongoose/services/paperless/mock/paperlessMockClient.js';
import { memoryModel } from './helpers/memoryModel.js';

const { readLive, normaliseRules, buildGuide, bankStatementAddresses, diffRules, recordSnapshot, loadHistory, loadOverview } = mailRules;
const { makeMockClient, resetMockPaperless, mockPaperlessState } = mockPaperless;
const ejs = createRequire(import.meta.url)('ejs');

/** Where to send documents: Paperless mail rules read live, checked, and their changes recorded. */

const liveRules = async () => normaliseRules(await readLive(makeMockClient()));
const rule = (to) => mockPaperlessState().mailRules.find((r) => r.filter_to === to);
const codes = (warnings) => warnings.map((w) => w.code).sort();

describe('mail rule guide', () => {
  beforeEach(() => resetMockPaperless());

  it('maps each document type hcs-app handles to its address and what it accepts', async () => {
    const { lines, warnings } = buildGuide(await liveRules());
    const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
    assert.deepEqual(byKey.purchaseInvoice.addresses.map((a) => [a.to, a.accepts]), [['purchase@example.test', 'attachments or the email body']]);
    assert.deepEqual(byKey.bankStatement.addresses.map((a) => [a.to, a.accepts]), [['bank@example.test', 'PDF attachments only']]);
    assert.equal(byKey.supplierStatement.addresses[0].to, 'statement@example.test');
    assert.equal(byKey.subcontractorInvoice.addresses[0].to, 'subcontractor@example.test');
    // Remittance advice isn't picked up by hcs-app but is still shown, by its Paperless name
    const other = lines.find((l) => !l.handled);
    assert.equal(other.label, 'Remittance Advice');
    assert.equal(other.addresses[0].to, 'remittance@example.test');
    assert.deepEqual(warnings, []);
  });

  it('gives the bank statements page its address', async () => {
    const guide = buildGuide(await liveRules());
    assert.deepEqual(bankStatementAddresses(guide), ['bank@example.test']);
    assert.deepEqual(bankStatementAddresses(null), []);
  });

  it('warns when a rule is disabled, and when nothing then files that type or tag', async () => {
    rule('bank@example.test').enabled = false;
    const { lines, warnings } = buildGuide(await liveRules());
    assert.deepEqual(codes(warnings), ['rule_disabled', 'tag_unassigned', 'type_unassigned']);
    assert.match(warnings.find((w) => w.code === 'rule_disabled').message, /bank@ rule/);
    assert.match(warnings.find((w) => w.code === 'tag_unassigned').message, /tag 12 \(bank-statement\)/);
    assert.deepEqual(lines.find((l) => l.key === 'bankStatement').addresses, []);
  });

  it('warns when a rule points at a type or tag that no longer exists', async () => {
    rule('statement@example.test').assign_document_type = 99;
    rule('remittance@example.test').assign_tags = [18, 77];
    const { warnings } = buildGuide(await liveRules());
    assert.deepEqual(codes(warnings), ['type_unassigned', 'unknown_tag', 'unknown_type']);
    assert.match(warnings.find((w) => w.code === 'unknown_type').message, /statement@ rule assigns document type 99/);
    assert.match(warnings.find((w) => w.code === 'unknown_tag').message, /remittance@ rule assigns tag 77/);
  });

  it('counts a rule that only adds the bank-statement tag as filing bank statements', async () => {
    rule('bank@example.test').assign_document_type = null;
    const { lines, warnings } = buildGuide(await liveRules());
    assert.deepEqual(lines.find((l) => l.key === 'bankStatement').addresses.map((a) => a.to), ['bank@example.test']);
    assert.deepEqual(codes(warnings), ['type_unassigned']);
  });
});

describe('mail rule history', () => {
  beforeEach(() => resetMockPaperless());

  it('records the first read, then nothing while the rules are unchanged', async () => {
    const Model = memoryModel();
    const first = await recordSnapshot(Model, await liveRules(), { now: new Date('2026-10-01T09:00:00Z') });
    assert.deepEqual(first, { baseline: true, changes: [], saved: true });
    const second = await recordSnapshot(Model, await liveRules(), { now: new Date('2026-10-01T10:00:00Z') });
    assert.deepEqual(second, { baseline: false, changes: [], saved: false });
    assert.equal(Model.docs.length, 1);
  });

  it('records a dated entry for each change to an address, type, tag, scope or enabled flag', async () => {
    const Model = memoryModel();
    await recordSnapshot(Model, await liveRules(), { now: new Date('2026-10-01T09:00:00Z') });

    rule('bank@example.test').enabled = false;
    rule('purchase@example.test').consumption_scope = 1;
    rule('statement@example.test').assign_document_type = 1;
    rule('subcontractor@example.test').assign_tags = [17, 16];
    rule('remittance@example.test').filter_to = 'remittances@example.test';
    const { changes } = await recordSnapshot(Model, await liveRules(), { now: new Date('2026-10-02T09:00:00Z') });

    assert.deepEqual(changes.map((c) => c.summary).sort(), [
      'bank@ rule disabled',
      'purchase@ rule now takes attachments only (was attachments and the email body)',
      'remittance@ rule now matches remittances@example.test (was remittance@example.test)',
      'statement@ rule now files as Purchase Invoice (was Supplier Statement)',
      'subcontractor@ rule now tags purchase-invoice, subcontractor-invoice (was subcontractor-invoice)',
    ]);
    const history = await loadHistory(Model);
    assert.equal(history.length, 2);
    assert.equal(history[0].changes.length, 5);
    assert.deepEqual(history[0].takenAt, new Date('2026-10-02T09:00:00Z'));
    assert.equal(history[1].baseline, true);
  });

  it('records rules added and removed', () => {
    const base = normaliseRules({ rules: [{ id: 1, name: 'A', filter_to: 'a@example.test', assign_tags: [] }] });
    const next = normaliseRules({ rules: [{ id: 2, name: 'B', filter_to: 'b@example.test', assign_tags: [], assign_document_type: 9 }] });
    assert.deepEqual(diffRules(base, next).map((c) => [c.kind, c.summary]), [
      ['added', 'New b@ rule ("B"): b@example.test files as type 9'],
      ['removed', 'a@ rule ("A") removed'],
    ]);
  });

  it('stores rule settings only', async () => {
    const Model = memoryModel();
    await recordSnapshot(Model, await liveRules());
    assert.deepEqual(Object.keys(Model.docs[0].rules[0]).sort(), [
      'account', 'attachmentFilter', 'documentType', 'documentTypeId', 'enabled', 'name', 'ruleId', 'scope', 'tagIds', 'tags', 'to',
    ]);
  });
});

describe('mail rule overview', () => {
  beforeEach(() => resetMockPaperless());

  it('reads live and records the snapshot', async () => {
    const Model = memoryModel();
    const o = await loadOverview({ api: makeMockClient(), Model });
    assert.equal(o.live, true);
    assert.equal(o.recorded.baseline, true);
    assert.equal(o.lines.length, 5);
  });

  it('falls back to the last snapshot when Paperless is unreachable', async () => {
    const Model = memoryModel();
    await loadOverview({ api: makeMockClient(), Model, now: new Date('2026-10-01T09:00:00Z') });
    mockPaperlessState().failNext.add('listMailRules');
    const o = await loadOverview({ api: makeMockClient(), Model });
    assert.equal(o.live, false);
    assert.deepEqual(o.seenAt, new Date('2026-10-01T09:00:00Z'));
    assert.deepEqual(bankStatementAddresses(o), ['bank@example.test']);
    assert.equal(Model.docs.length, 1);
  });

  it('shows a calm message, not an error, with nothing saved yet', async () => {
    mockPaperlessState().failNext.add('listMailRules');
    const overview = await loadOverview({ api: makeMockClient(), Model: memoryModel() });
    assert.equal(overview.live, false);
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/mailRules.ejs'), { overview, history: [], isAdmin: false });
    assert.match(html, /Paperless can't be reached just now/);
    assert.ok(!/Where to send it/.test(html));
  });

  it('renders the guide, the history, and an admin pointer to the warnings', async () => {
    const Model = memoryModel();
    rule('bank@example.test').enabled = false;
    const overview = await loadOverview({ api: makeMockClient(), Model });
    const history = await loadHistory(Model);
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/paperless/mailRules.ejs'), { overview, history, isAdmin: true });
    assert.match(html, /purchase@example\.test<\/span>\s*<span[^>]*>\(attachments or the email body\)/);
    assert.match(html, /No address is set up for these/);
    assert.match(html, /3 problems with the mail rules/);
    assert.match(html, /First recorded: 5 mail rules/);
    assert.ok(!/<script/.test(html));
  });

  it('shows the warnings on the Paperless settings page', async () => {
    rule('bank@example.test').enabled = false;
    const mr = await loadOverview({ api: makeMockClient() });
    const group = { id: 'paperless', label: 'Paperless-ngx', icon: 'x', description: '', keys: [], fields: [], counts: { store: 0, env: 0, unset: 0, adoptable: 0 } };
    const html = await ejs.renderFile(path.resolve('mongoose/views/tailwindcss/admin/configGroup.ejs'), { group, title: 'Paperless-ngx', csrfToken: 't', mailRules: mr });
    assert.match(html, /The bank@ rule \(&#34;Bank statements&#34;\) is disabled in Paperless/);
    assert.match(html, /href="\/paperless\/mail-rules"/);
  });
});

describe('mail rule wiring', () => {
  const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

  it('is a scheduled job, a route open to admins and accountants, and linked from the queues and bank statements', () => {
    assert.match(read('mongoose/services/jobRegistry.js'), /scheduler\.register\('paperless-mail-rules'/);
    assert.match(read('mongoose/routes/paperlessRoutes.js'), /"\/paperless\/mail-rules", authService\.ensureAuthenticated, authService\.ensureRoles\("admin", "accountant"\)/);
    assert.match(read('mongoose/config/rolePermissionsConfig.js'), /'\/paperless\/mail-rules':\s+\['admin', 'accountant'\]/);
    assert.match(read('mongoose/views/tailwindcss/paperless/queue.ejs'), /href="\/paperless\/mail-rules"/);
    const bank = read('mongoose/views/tailwindcss/bank/statements.ejs');
    assert.match(bank, /href="\/paperless\/mail-rules"/);
    assert.ok(!/bank statements mailbox/.test(bank));
  });
});
