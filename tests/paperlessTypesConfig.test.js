import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAPERLESS_DOCUMENT_TYPES,
  documentTypeQuery,
  isDocumentType,
} from '../mongoose/config/paperlessTypesConfig.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Document types used to be matched by literal name. Renaming a type in the
 * Paperless UI silently broke those queries — they matched nothing, returned
 * empty, and raised no error. These tests exist so that cannot recur.
 */

/** Evaluate a query fragment against a cached documentType, as Mongo would. */
function matches(query, documentType) {
  return query.$or.some((clause) => {
    if ('documentType.id' in clause) return documentType.id === clause['documentType.id'];
    const rx = clause['documentType.name'].$regex;
    return rx.test(String(documentType.name ?? ''));
  });
}

describe('paperlessTypesConfig', () => {
  it('knows the four document types in use', () => {
    assert.deepEqual(
      Object.keys(PAPERLESS_DOCUMENT_TYPES).sort(),
      ['bankStatement', 'purchaseInvoice', 'subcontractorInvoice', 'supplierStatement'],
    );
  });

  describe('documentTypeQuery()', () => {
    it('matches on the id, which survives a rename', () => {
      const q = documentTypeQuery('purchaseInvoice');
      assert.ok(matches(q, { id: 1, name: 'anything at all' }));
    });

    it('matches the current name', () => {
      // hcs-app caches documentType.name, so a freshly renamed type takes a
      // full grab to propagate — both names have to work meanwhile.
      assert.ok(matches(documentTypeQuery('purchaseInvoice'), { id: 99, name: 'Purchase Invoice' }));
      assert.ok(matches(documentTypeQuery('supplierStatement'), { id: 99, name: 'Supplier Statement' }));
      assert.ok(matches(documentTypeQuery('subcontractorInvoice'), { id: 99, name: 'Subcontractor Invoice' }));
    });

    it('still matches the pre-rename name', () => {
      assert.ok(matches(documentTypeQuery('purchaseInvoice'), { id: 99, name: 'purchase' }));
      assert.ok(matches(documentTypeQuery('supplierStatement'), { id: 99, name: 'statement' }));
      assert.ok(matches(documentTypeQuery('subcontractorInvoice'), { id: 99, name: 'subcontractor' }));
    });

    it('is case-insensitive', () => {
      assert.ok(matches(documentTypeQuery('purchaseInvoice'), { id: 99, name: 'PURCHASE INVOICE' }));
    });

    it('does not confuse a supplier statement with a bank statement', () => {
      // The two are entirely different documents that share a word. A loose
      // /statement/i match would pull bank statements into the payroll view.
      const supplier = documentTypeQuery('supplierStatement');
      assert.ok(!matches(supplier, { id: 4, name: 'Bank Statement' }));

      const bank = documentTypeQuery('bankStatement');
      assert.ok(!matches(bank, { id: 2, name: 'Supplier Statement' }));
      assert.ok(!matches(bank, { id: 2, name: 'statement' }));
    });

    it('anchors names so a partial does not match', () => {
      assert.ok(!matches(documentTypeQuery('purchaseInvoice'), { id: 99, name: 'purchase order' }));
      assert.ok(!matches(documentTypeQuery('supplierStatement'), { id: 99, name: 'statements' }));
    });

    it('throws on an unknown key rather than returning a query matching nothing', () => {
      assert.throws(() => documentTypeQuery('nope'), /Unknown Paperless document type/);
    });
  });

  describe('isDocumentType()', () => {
    it('accepts the id, and either name', () => {
      assert.equal(isDocumentType({ id: 2, name: 'whatever' }, 'supplierStatement'), true);
      assert.equal(isDocumentType({ id: 99, name: 'statement' }, 'supplierStatement'), true);
      assert.equal(isDocumentType({ id: 99, name: 'Supplier Statement' }, 'supplierStatement'), true);
    });

    it('rejects a different type and tolerates missing input', () => {
      assert.equal(isDocumentType({ id: 4, name: 'Bank Statement' }, 'supplierStatement'), false);
      assert.equal(isDocumentType(null, 'supplierStatement'), false);
      assert.equal(isDocumentType(undefined, 'supplierStatement'), false);
      assert.equal(isDocumentType({}, 'supplierStatement'), false);
    });
  });

  describe('no call site matches a document type by literal name', () => {
    const FILES = [
      'mongoose/services/attendanceService.js',
      'mongoose/services/documentsOverviewService.js',
      'mongoose/controllers/paperlessController.js',
    ];

    it('uses documentTypeQuery instead of a hardcoded name', () => {
      for (const file of FILES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        // Strip comments so the explanatory ones do not trip this.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(
          !/['"]documentType\.name['"]\s*:\s*(['"]|\{\s*\$regex)/.test(code),
          `${file} still matches a document type by literal name — rename it to documentTypeQuery()`,
        );
        assert.ok(code.includes('documentTypeQuery('), `${file} does not use documentTypeQuery`);
      }
    });

    it('does not combine the fragment with a competing $or', () => {
      // documentTypeQuery returns an $or. Spreading it into a query that
      // already defines $or would silently drop one of them.
      for (const file of FILES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const m of src.matchAll(/\{[^{}]*documentTypeQuery\([^)]*\)[^{}]*\}/g)) {
          assert.ok(!/\$or\s*:/.test(m[0]), `${file}: documentTypeQuery spread alongside its own $or:\n${m[0]}`);
        }
      }
    });
  });
});
