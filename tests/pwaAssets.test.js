import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const layout = read('mongoose/views/tailwindcss/layout.ejs');
const manifest = JSON.parse(read('public/manifest/manifest.json'));

describe('PWA wiring', () => {
  it('serves the service worker from the site root', () => {
    // A worker's scope is the path it is served from. Registering it under
    // /resources/js/ scopes it to /resources/js/, where it controls no real page.
    assert.ok(
      fs.existsSync(path.join(ROOT, 'public/service-worker.js')),
      'public/service-worker.js must exist at the public root',
    );
    assert.ok(
      !fs.existsSync(path.join(ROOT, 'public/js/service-worker.js')),
      'the old /resources/js/ copy must not come back',
    );
    assert.match(layout, /register\('\/service-worker\.js'\)/);
  });

  it('links the manifest from an unauthenticated root path', () => {
    assert.match(layout, /rel="manifest"\s+href="\/manifest\.json"/);
  });

  it('declares the icon sizes browsers require to offer an install', () => {
    const sizes = new Set(manifest.icons.map((i) => i.sizes));
    assert.ok(sizes.has('192x192'), '192x192 icon is required for installability');
    assert.ok(sizes.has('512x512'), '512x512 icon is required for installability');
    assert.ok(
      manifest.icons.some((i) => i.purpose === 'maskable'),
      'a maskable icon is required for a non-letterboxed Android icon',
    );
    assert.equal(manifest.id, '/');
    assert.equal(manifest.scope, '/');
  });

  it('ships every icon file the manifest references', () => {
    for (const icon of manifest.icons) {
      const rel = icon.src.replace('/resources/images/', 'public/images/');
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing icon file: ${icon.src}`);
    }
  });

  it('does not cache page HTML in the service worker', () => {
    // This is an ERP on shared site devices: cached pages would let the next user
    // page back through the previous user's payroll/HR data after logout.
    const sw = read('public/service-worker.js');
    assert.match(sw, /request\.mode === 'navigate'/);
    assert.match(sw, /caches\.match\(OFFLINE_URL\)/);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'public/offline.html')),
      'the offline fallback page must exist or install fails',
    );
  });
});

describe('third-party browser assets are self-hosted', () => {
  const views = ['mongoose/views/tailwindcss/layout.ejs',
    'mongoose/views/tailwindcss/setup/_header.ejs',
    'mongoose/views/tailwindcss/admin/deletedItems.ejs'];

  it('loads no scripts or styles from a CDN', () => {
    for (const view of views) {
      assert.ok(!/cdn\.jsdelivr\.net/.test(read(view)), `${view} still references jsdelivr`);
    }
  });

  it('keeps jsdelivr out of the CSP', () => {
    assert.ok(!/cdn\.jsdelivr\.net/.test(read('services/securityService.js')));
  });

  it('pins the vendored libraries to exact versions', () => {
    const { devDependencies: dev } = JSON.parse(read('package.json'));
    for (const pkg of ['@alpinejs/csp', 'quill', 'chart.js', 'bootstrap-icons']) {
      assert.ok(dev[pkg], `${pkg} must be a devDependency so it can be vendored`);
      assert.match(dev[pkg], /^\d+\.\d+\.\d+$/, `${pkg} must be pinned exactly, got ${dev[pkg]}`);
    }
  });
});

describe('mobile navigation', () => {
  it('keeps nav labels visible at every breakpoint', () => {
    // Labels were `hidden sm:inline`, leaving phone users ~11 unlabelled icons.
    const nav = layout.slice(layout.indexOf('<nav'), layout.indexOf('</nav>'));
    assert.ok(!/hidden sm:inline/.test(nav), 'nav labels must not be hidden on small screens');
  });

  it('gives icon-only controls an accessible name', () => {
    assert.match(layout, /aria-label="Main navigation"/);
    assert.match(layout, /aria-label="Toggle light or dark theme"/);
    assert.match(layout, /aria-hidden="true"/);
  });

  it('emits aria-current unescaped so it is a real attribute', () => {
    // <%= %> would escape the quotes into &#34;, producing a dead attribute.
    assert.match(layout, /<%-\s*navActive\([^)]*\)\s*\?\s*'aria-current="page"'/);
  });
});
