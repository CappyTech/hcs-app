import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fileStorage from '../services/fileStorage.js';
import { PUBLIC_PREFIXES_FOR_TEST } from '../services/authService.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('upload storage location', () => {
  it('keeps the store outside public/', () => {
    // public/ is served statically. Anything under it is world-readable.
    const publicDir = path.join(ROOT, 'public');
    assert.ok(
      !fileStorage.STORAGE_ROOT.startsWith(publicDir + path.sep),
      `storage root must not be inside public/: ${fileStorage.STORAGE_ROOT}`,
    );
    assert.ok(
      !fileStorage.getModelDir('project').startsWith(publicDir + path.sep),
      'model dirs must not be inside public/',
    );
  });

  it('keeps multer temp on the same root as the destination', () => {
    // fs.rename cannot cross filesystems (EXDEV), and a relative dest resolves
    // against the process cwd rather than anywhere meaningful.
    assert.ok(path.isAbsolute(fileStorage.TEMP_DIR));
    assert.ok(fileStorage.TEMP_DIR.startsWith(fileStorage.STORAGE_ROOT));
  });

  it('lowercases model dirs consistently', () => {
    // Writes went to public/<model> while URLs used a capitalised name — different
    // paths on a case-sensitive filesystem.
    assert.equal(fileStorage.getModelDir('Project'), fileStorage.getModelDir('project'));
  });

  it('refuses paths that escape the record directory', () => {
    assert.equal(fileStorage.resolveFilePath('project', 'abc', '../../etc/passwd'), null);
    assert.equal(fileStorage.resolveFilePath('project', 'abc', '../secret.docx'), null);
    assert.ok(fileStorage.resolveFilePath('project', 'abc', 'photo.jpg'));
  });

  it('ships no user documents inside public/', () => {
    const stray = fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !['css', 'js', 'images', 'manifest', 'vendor'].includes(n));
    assert.deepEqual(stray, [], `unexpected directories under public/: ${stray.join(', ')}`);
  });
});

describe('documents are served through an authenticated route', () => {
  it('does not link documents at a static /resources path', () => {
    const ctrl = read('mongoose/controllers/fileController.js');
    assert.ok(
      !/\/resources\/\$\{modelDisplay\}/.test(ctrl),
      'file URLs must not point at the static /resources tree',
    );
    assert.match(ctrl, /\/download\//);
  });

  it('authorises every file route against the parent record', () => {
    const routes = read('mongoose/routes/fileRoutes.js');
    const handlers = routes.split('router.').slice(1);
    assert.ok(handlers.length >= 5, 'expected the five file routes');
    for (const h of handlers) {
      assert.match(h, /ensureCanAccessRecord\('[ru]'\)/,
        'every file route must authorise against the parent record');
      assert.match(h, /ensureAuthenticated/);
    }
    assert.ok(!/ensureRole\("admin"\)/.test(routes),
      'flat admin gating replaced by per-record authorisation');
  });
});

describe('public path prefixes', () => {
  it('does not treat all of /resources/ as public', () => {
    assert.ok(
      !PUBLIC_PREFIXES_FOR_TEST.includes('/resources/'),
      'a blanket /resources/ prefix defeats the auth guard on the static mount',
    );
  });

  it('keeps the asset subtrees the login page needs', () => {
    for (const p of ['/resources/css/', '/resources/js/', '/resources/images/', '/resources/vendor/']) {
      assert.ok(PUBLIC_PREFIXES_FOR_TEST.includes(p), `${p} must stay public`);
    }
  });
});
