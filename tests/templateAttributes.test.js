import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Catches a malformed attribute such as `class=""flex …`: the browser reads an
 * empty class and drops the rest, so the element loses all its styling. 6.145.0
 * shipped one on the list page's Table/List toggle, which shrank to 14px wide.
 */

const VIEWS = path.resolve('mongoose/views/tailwindcss');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  return d.isDirectory() ? walk(p) : (d.name.endsWith('.ejs') ? [p] : []);
});

describe('EJS view attributes', () => {
  it('never open an attribute value with a doubled quote', () => {
    const bad = [];
    for (const file of walk(VIEWS)) {
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/\s[a-z-]+=""[A-Za-z<]/.test(line)) bad.push(`${path.relative(VIEWS, file)}:${i + 1}`);
      });
    }
    assert.deepEqual(bad, []);
  });
});
