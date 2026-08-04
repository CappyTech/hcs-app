import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAPERLESS_TAGS } from '../mongoose/config/paperlessTagsConfig.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ingest talks to Paperless over HTTP, so these cover the decisions rather
 * than the plumbing: which documents are selected, when a statement is refused,
 * and that the outcome is written back without destroying the selecting tag.
 */
describe('bankStatementIngestService', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mongoose/services/bankStatementIngestService.js'), 'utf8');

  it('selects documents by tag id, never by a name search', () => {
    // A `tag:bank-statement` query string would be at the mercy of renames, and
    // there is already a `statements` tag holding supplier statements of
    // account — a different document that shares a word.
    assert.match(src, /tagsIdAll:\s*tagId/);
    assert.match(src, /PAPERLESS_TAGS\.bankStatement\.id/);
    assert.ok(!/tag:bank-statement/.test(src), 'must not filter by a tag name string');
  });

  it('merges the outcome tag rather than replacing the document tags', () => {
    // Replacing would drop `bank-statement` and make the document invisible to
    // the next run.
    const call = src.match(/updatePaperlessDocumentTags\(.*?\);/s);
    assert.ok(call, 'no updatePaperlessDocumentTags call found');
    assert.match(call[0], /merge:\s*true/);
  });

  it('refuses to guess an account', () => {
    // Attributing a statement to the wrong account produces a confidently
    // wrong reconciliation, so an unresolvable one is held for a human.
    assert.match(src, /if \(accountId == null\)/);
    assert.match(src, /bankStatementNeedsReview/);
    // The parse must not run without an account.
    const guardAt = src.indexOf('if (accountId == null)');
    const importAt = src.indexOf('statements.importStatement');
    assert.ok(guardAt > -1 && importAt > guardAt, 'the account guard must precede the parse');
  });

  it('parses as OCR, so the balance chain decides whether lines are trusted', () => {
    assert.match(src, /format:\s*'ocr'/);
    assert.match(src, /source:\s*'paperless'/);
  });

  it('records paperlessId so a repeated grab updates rather than duplicates', () => {
    assert.match(src, /paperlessId:\s*doc\.id/);
  });

  it('does not let one bad document abandon the batch', () => {
    assert.match(src, /catch \(err\)[\s\S]*stats\.failed \+= 1/);
  });

  it('maps every parse outcome to its own tag', () => {
    for (const key of ['bankStatementParsed', 'bankStatementNeedsReview', 'bankStatementFailed']) {
      assert.ok(src.includes(key), `no tag write for ${key}`);
      assert.ok(PAPERLESS_TAGS[key], `${key} is not a configured tag`);
    }
  });

  it('is registered as a scheduled job and a manual route', () => {
    const jobs = fs.readFileSync(path.join(ROOT, 'mongoose/services/jobRegistry.js'), 'utf8');
    assert.match(jobs, /scheduler\.register\('bank-statement-grab'/);

    const routes = fs.readFileSync(path.join(ROOT, 'mongoose/routes/bankRoutes.js'), 'utf8');
    assert.match(routes, /'\/bank\/statements\/grab'/);
    // Rate-limited: it fans out to the Paperless API.
    assert.match(routes, /'\/bank\/statements\/grab'[^;]*generateLimiter/);
  });

  it('the four bank-statement tags are configured with distinct ids', () => {
    const ids = ['bankStatement', 'bankStatementParsed', 'bankStatementNeedsReview', 'bankStatementFailed']
      .map(k => PAPERLESS_TAGS[k].id);
    assert.equal(new Set(ids).size, 4, 'tag ids must be distinct');
  });
});
