import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import securityEvent from '../mongoose/models/mongoose/INTERNAL/securityEvent.js';

// auditLogService.record() is fire-and-forget: a type missing from the
// securityEvent enum fails validation, is logged, and the row is lost. Every
// type the code records must be in the list.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('security event types', () => {
  it('every type passed to auditLog.record() is accepted by the securityEvent model', () => {
    const allowed = new Set(securityEvent.schema.path('type').enumValues);
    const used = new Set();
    for (const f of [...sources(path.join(ROOT, 'mongoose')), ...sources(path.join(ROOT, 'services'))]) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/auditLog\.record\(([^,]+),/g)) {
        for (const t of m[1].matchAll(/['"]([a-z_]+)['"]/g)) used.add(t[1]);
      }
    }
    assert.ok(used.size > 10, 'found the record() calls');
    const missing = [...used].filter((t) => !allowed.has(t));
    assert.deepEqual(missing, []);
  });
});
