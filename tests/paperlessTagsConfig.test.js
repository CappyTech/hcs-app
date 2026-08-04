import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

import {
  PAPERLESS_TAGS,
  tagElemMatch,
  hasTagQuery,
  lacksAllTagsQuery,
  hasTag,
  tagName,
} from '../mongoose/config/paperlessTagsConfig.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tags used to be matched by literal name, so renaming one in Paperless
 * silently changed behaviour with no error anywhere. These lock in the
 * id-first matching that replaced it.
 */

/** Evaluate an $elemMatch clause against one cached tag, as Mongo would. */
function elemMatches(clause, tag) {
  return clause.$or.some((c) => {
    if ('id' in c) return tag.id === c.id;
    return c.name.$in.some(rx => rx.test(String(tag.name ?? '')));
  });
}

describe('paperlessTagsConfig', () => {
  describe('tagElemMatch()', () => {
    it('matches on the id, which survives a rename', () => {
      assert.ok(elemMatches(tagElemMatch('added'), { id: 2, name: 'renamed to something else' }));
    });

    it('matches on the name, covering the window before a grab refreshes the cache', () => {
      assert.ok(elemMatches(tagElemMatch('added'), { id: 999, name: 'added' }));
      assert.ok(elemMatches(tagElemMatch('creditRefund'), { id: 999, name: 'credit/refund' }));
    });

    it('is case- and whitespace-tolerant', () => {
      assert.ok(elemMatches(tagElemMatch('added'), { id: 999, name: '  ADDED ' }));
    });

    it('does not match a different tag', () => {
      assert.ok(!elemMatches(tagElemMatch('added'), { id: 9, name: 'notified' }));
      // 'added' must not match 'manually added to kashflow' — the names overlap
      // and a loose /added/i would conflate two opposite meanings.
      assert.ok(!elemMatches(tagElemMatch('added'), { id: 11, name: 'manually added to kashflow' }));
    });

    it('handles the spaced live name of the data-entry tag', () => {
      // Live Paperless has 'data entry done'; the code has long said
      // 'data-entry-done'. Both resolve.
      for (const name of ['data entry done', 'data-entry-done', 'data_entry_done']) {
        assert.ok(elemMatches(tagElemMatch('dataEntryDone'), { id: 999, name }), name);
      }
    });

    it('throws on an unknown tag rather than matching nothing', () => {
      assert.throws(() => tagElemMatch('nope'), /Unknown Paperless tag/);
    });
  });

  describe('query builders', () => {
    it('hasTagQuery nests under `tags`, so it composes as a value not a top-level $or', () => {
      const q = hasTagQuery('added');
      assert.deepEqual(Object.keys(q), ['tags']);
      assert.ok(q.tags.$elemMatch);
    });

    it('lacksAllTagsQuery excludes every listed tag by id and name', () => {
      const q = lacksAllTagsQuery(['originalMultiInvoice', 'creditRefund']);
      const clause = q.tags.$not.$elemMatch;
      const ids = clause.$or.filter(c => 'id' in c).map(c => c.id);
      assert.deepEqual(ids.sort(), [PAPERLESS_TAGS.originalMultiInvoice.id, PAPERLESS_TAGS.creditRefund.id].sort());
      assert.ok(elemMatches(clause, { id: 999, name: 'credit/refund' }));
      assert.ok(!elemMatches(clause, { id: 2, name: 'added' }));
    });
  });

  describe('hasTag()', () => {
    it('accepts id, current name, and tolerates odd shapes', () => {
      assert.equal(hasTag([{ id: 2, name: 'whatever' }], 'added'), true);
      assert.equal(hasTag([{ id: 999, name: 'Added' }], 'added'), true);
      // A string tag array has been seen in the wild.
      assert.equal(hasTag(['added'], 'added'), true);
      // Some payloads capitalise the key.
      assert.equal(hasTag([{ Name: 'added' }], 'added'), true);
    });

    it('returns false for absent, empty and malformed input', () => {
      assert.equal(hasTag([], 'added'), false);
      assert.equal(hasTag(null, 'added'), false);
      assert.equal(hasTag(undefined, 'added'), false);
      assert.equal(hasTag([null, {}], 'added'), false);
      assert.equal(hasTag([{ id: 9, name: 'notified' }], 'added'), false);
    });

    it('supports the "only tag is added" check the send-lock depends on', () => {
      // Preserves the original semantics: at least one tag, and every one of
      // them is 'added'. Getting this wrong disables the duplicate-send lock.
      const onlyAdded = (tags) => tags.length > 0 && tags.every(t => hasTag([t], 'added'));
      assert.equal(onlyAdded([{ id: 2, name: 'added' }]), true);
      assert.equal(onlyAdded([{ id: 2, name: 'added' }, { id: 9, name: 'notified' }]), false);
      assert.equal(onlyAdded([]), false);
    });
  });

  it('tagName returns the canonical name to write back to Paperless', () => {
    assert.equal(tagName('bankStatementParsed'), 'bank-statement/parsed');
    assert.equal(tagName('dataEntryDone'), 'data entry done');
  });

  describe('no call site matches a tag by literal name', () => {
    const FILES = [
      'mongoose/services/documentsOverviewService.js',
      'mongoose/controllers/paperlessController.js',
    ];

    it('routes tag decisions through paperlessTagsConfig', () => {
      for (const file of FILES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // The tag names the code used to branch on.
        for (const literal of ['original/multiple invoice one pdf', 'manually added to kashflow', 'credit/refund']) {
          assert.ok(
            !code.includes(literal),
            `${file} still references the literal tag name "${literal}"`,
          );
        }
        assert.ok(
          !/\bn\s*===\s*'added'/.test(code),
          `${file} still compares a tag name to 'added' directly`,
        );
      }
    });

    it('never spreads a tag requirement alongside a tag exclusion', () => {
      // hasTagQuery and lacksAllTagsQuery both set a `tags` key, so spreading
      // both into one object silently drops whichever came first — the
      // requirement usually, leaving a query that quietly matches too much.
      // The addedNoKf facet broke exactly this way while these were being
      // introduced, and now uses an explicit $and.
      //
      // One lacksAllTagsQuery overriding another IS intentional:
      // NEVER_SENT_ELIGIBLE_MATCH widens KF_ELIGIBLE_MATCH's exclusion list,
      // as the original code did, so that case is allowed.
      const src = fs.readFileSync(path.join(ROOT, 'mongoose/services/documentsOverviewService.js'), 'utf8');
      for (const m of src.matchAll(/\{[^{}]*\.\.\.hasTagQuery\([^)]*\)[^{}]*\}/g)) {
        assert.ok(
          !/\.\.\.(lacksAllTagsQuery|KF_ELIGIBLE_MATCH|NEVER_SENT_ELIGIBLE_MATCH)\b/.test(m[0]),
          `a tag requirement is spread alongside a tag exclusion — use $and:\n${m[0]}`,
        );
      }
    });
  });

  it('paperless/read.ejs renders with hasTag supplied from res.locals', () => {
    // The view now depends on a res.locals helper; without it the page 500s.
    const file = path.join(ROOT, 'mongoose/views/tailwindcss/paperless/read.ejs');
    // The same locals paperlessController.readOcr supplies.
    const locals = {
      hasTag,
      title: 'Test document',
      doc: {
        paperlessId: 1, title: 'Test', tags: [{ id: 2, name: 'added' }],
        customFields: [], kashflowPurchaseNumber: null, kashflowPermalink: null,
      },
      ingest: null,
      hasDrift: false,
      cfKashflowPurchaseId: null,
      hashDuplicate: null,
      slimDateTime: () => '01/01/2025',
      formatCurrency: (n) => `£${Number(n || 0).toFixed(2)}`,
      csrfToken: 't',
    };
    const html = ejs.renderFile(file, locals, { async: false });
    return html.then((out) => {
      // Tagged 'added' with no KashFlow number => the warning must appear.
      assert.match(out, /KashFlow linkage missing/);
    });
  });
});
