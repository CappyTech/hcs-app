import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import entry from '../mongoose/services/paperless/documentEntryService.js';

/**
 * Every bare `OcrDocument` in sendDraftToKashflow must be inside a block that
 * declares it (`const { OcrDocument } = mdb.PAPERLESS`). From 6.47.0 until 6.53.1
 * the H6 "record the send" call used it outside its block: the purchase was
 * created, then the send threw "OcrDocument is not defined", showed as failed
 * and the document never moved to In KashFlow.
 */
/**
 * Blank out comments and the text of strings and template literals, keeping
 * the code inside template ${…} (it can use the name too). A regex can't do
 * this: an apostrophe inside a template literal ("This document's …") would
 * start a fake string that swallows real code.
 */
function codeOnly(src) {
  let out = '';
  const stack = []; // '`' while inside template text, '${' while inside its code
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    const inTemplateText = stack.at(-1) === '`';
    if (inTemplateText) {
      if (ch === '\\') { out += '  '; i += 2; continue; }
      if (ch === '`') { stack.pop(); out += '`'; i += 1; continue; }
      if (two === '${') { stack.push('${'); out += '${'; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (two === '//') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += ch + ch;
      i = j + 1;
      continue;
    }
    if (ch === '`') { stack.push('`'); out += '`'; i += 1; continue; }
    if (ch === '{' && stack.at(-1) === '${') { stack.push('{'); }
    if (ch === '}' && stack.length && stack.at(-1) !== '`') {
      const top = stack.pop();
      if (top === '${') { out += '}'; i += 1; continue; } // back to template text
    }
    out += ch;
    i += 1;
  }
  return out;
}

function undeclaredUses(src, name) {
  const code = codeOnly(src);
  const declared = []; // depth at which each declaration was made
  const bad = [];
  let depth = 0;
  // `{ OcrDocument }` declares it; `{ OcrDocument: OcrDocumentSend }` renames it and doesn't
  const declRe = new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b(?!\\s*:)[^}]*\\}\\s*=|(?:const|let|var)\\s+${name}\\b`, 'y');
  const useRe = new RegExp(`\\b${name}\\b`, 'y');
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      while (declared.length && declared.at(-1) >= depth) declared.pop();
      depth -= 1;
    }
    declRe.lastIndex = i;
    const decl = declRe.exec(code);
    if (decl) {
      // The destructuring braces are counted as we pass them; the name belongs to the enclosing block
      declared.push(depth);
      i += decl[0].length - 1;
      continue;
    }
    useRe.lastIndex = i;
    if (useRe.exec(code)) {
      const before = code.slice(Math.max(0, i - 1), i);
      // A property key ({ OcrDocument: Other }) isn't a use either
      const isKey = /[{,]\s*$/.test(code.slice(Math.max(0, i - 20), i)) && /^\s*:/.test(code.slice(i + name.length, i + name.length + 5));
      const qualified = before === '.' || /\w/.test(before) || isKey;
      if (!qualified && !declared.length) bad.push(code.slice(i - 40, i + 40).replace(/\s+/g, ' '));
      i += name.length - 1;
    }
  }
  return bad;
}

describe('recording a KashFlow send', () => {
  // Windows checkouts can have CRLF line endings
  const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = ctrl.indexOf('export const sendDraftToKashflow');
  const end = ctrl.indexOf('\n};\n', start);
  const send = ctrl.slice(start, end + 3);

  it('never uses OcrDocument outside the block that declares it', () => {
    assert.ok(send.length > 1000, 'found the send handler');
    assert.deepEqual(undeclaredUses(send, 'OcrDocument'), []);
  });

  it('the scope check does catch the bug', () => {
    const buggy = `async () => {
      try { const { OcrDocument } = mdb.PAPERLESS; await OcrDocument.updateOne({}); } catch (e) {}
      await documentEntry.recordSentToKashflow(OcrDocument, id);
    }`;
    assert.equal(undeclaredUses(buggy, 'OcrDocument').length, 1);
    // A renamed binding elsewhere doesn't hide it (this masked the real bug), nor does template text
    const renamed = `async () => {
      const { OcrDocument: Other } = mdb.PAPERLESS;
      const m = \`This document's id is \${id}\`;
      await documentEntry.recordSentToKashflow(OcrDocument, id);
    }`;
    assert.equal(undeclaredUses(renamed, 'OcrDocument').length, 1);
    assert.deepEqual(undeclaredUses(buggy.replace('recordSentToKashflow(OcrDocument', 'recordSentToKashflow(mdb.PAPERLESS.OcrDocument'), 'OcrDocument'), []);
  });
});

describe('repairing sends that were never recorded', () => {
  // Enough of a model for documentStateService.transition, with real Mongo matching
  function model(docs) {
    const q = (r) => ({ select: () => q(r), lean: async () => structuredClone(r) });
    return {
      docs,
      find: (f) => q(docs.filter(sift(f))),
      findOne: (f) => q(docs.find(sift(f)) || null),
      findOneAndUpdate: (f, u) => {
        const d = docs.find(sift(f));
        if (d) Object.assign(d, u.$set || {});
        return q(d || null);
      },
    };
  }
  const PI = { id: 1, name: 'Purchase Invoice' };

  it('moves linked invoices to In KashFlow and leaves everything else alone', async () => {
    const m = model([
      { paperlessId: 1, documentType: PI, processingState: 'entered', kashflowPurchaseId: 14937, lastSendStatus: 201, deletedInPaperlessAt: null },
      { paperlessId: 2, documentType: PI, processingState: 'awaiting_entry', kashflowPurchaseId: 14900, lastSendStatus: 201, deletedInPaperlessAt: null },
      { paperlessId: 3, documentType: PI, processingState: 'entered', kashflowPurchaseId: null, lastSendStatus: null, deletedInPaperlessAt: null },
      { paperlessId: 4, documentType: PI, processingState: 'entered', kashflowPurchaseId: 14800, lastSendStatus: 400, deletedInPaperlessAt: null },
      { paperlessId: 5, documentType: PI, processingState: 'sent', kashflowPurchaseId: 14700, lastSendStatus: 201, deletedInPaperlessAt: null },
      // #1139: linked with Match Purchase (status 200, or none), never sent from hcs-app
      { paperlessId: 6, documentType: PI, processingState: 'entered', kashflowPurchaseId: 153542300, lastSendStatus: 200, deletedInPaperlessAt: null },
      { paperlessId: 7, documentType: PI, processingState: 'awaiting_entry', kashflowPurchaseId: 153542301, lastSendStatus: null, deletedInPaperlessAt: null },
    ]);
    const r = await entry.repairUnmarkedSends(m);
    assert.deepEqual(r.repaired.sort(), [1, 2, 6, 7]);
    assert.deepEqual(m.docs.map((d) => [d.paperlessId, d.processingState]), [[1, 'sent'], [2, 'sent'], [3, 'entered'], [4, 'entered'], [5, 'sent'], [6, 'sent'], [7, 'sent']]);
    // Running it again changes nothing
    assert.deepEqual((await entry.repairUnmarkedSends(m)).repaired, []);
  });

  it('can be limited to one document, as Match Purchase does', async () => {
    const m = model([
      { paperlessId: 6, documentType: PI, processingState: 'entered', kashflowPurchaseId: 1, lastSendStatus: 200, deletedInPaperlessAt: null },
      { paperlessId: 8, documentType: PI, processingState: 'entered', kashflowPurchaseId: 2, lastSendStatus: 200, deletedInPaperlessAt: null },
    ]);
    assert.deepEqual((await entry.repairUnmarkedSends(m, { paperlessIds: [6] })).repaired, [6]);
    assert.equal(m.docs[1].processingState, 'entered');
    const ctrl = fs.readFileSync(path.resolve('mongoose/controllers/paperlessController.js'), 'utf8');
    assert.match(ctrl, /repairUnmarkedSends\(OcrDocument, \{ paperlessIds: \[paperlessId\] \}\)/);
  });

  it('is registered as a background job', () => {
    const jobs = fs.readFileSync(path.resolve('mongoose/services/jobRegistry.js'), 'utf8');
    assert.match(jobs, /scheduler\.register\('paperless-repair-unmarked-sends'/);
    assert.match(jobs, /repairUnmarkedSends\(__mdbForJobs\.PAPERLESS\.OcrDocument\)/);
  });
});
