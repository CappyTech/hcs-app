#!/usr/bin/env node
/**
 * Copy third-party browser assets out of node_modules into public/vendor/.
 *
 * These used to be loaded from cdn.jsdelivr.net. Serving them ourselves removes a
 * third-party origin from the CSP, pins the versions to package.json (the Alpine tag
 * was `3.x.x`, which resolved to a URL that 404'd), and keeps the app working on the
 * poor/restricted connections site staff actually use.
 *
 * public/vendor/ is generated, not committed — the Docker builder stage runs this and
 * copies the result into the runtime image, the same way it does for tailwind.css.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'public', 'vendor');

// [source relative to node_modules, destination relative to public/vendor]
const ASSETS = [
  // Alpine's CSP build lives in its own package from 3.15 on. It is the build this app
  // needs: the standard build evaluates expressions at runtime, which our CSP forbids.
  ['@alpinejs/csp/dist/cdn.min.js', 'alpine-csp.min.js'],
  ['quill/dist/quill.js', 'quill.js'],
  ['quill/dist/quill.snow.css', 'quill.snow.css'],
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['bootstrap-icons/font/bootstrap-icons.min.css', 'bootstrap-icons.min.css'],
  // bootstrap-icons.css references ./fonts/* relatively, so the subdirectory must survive.
  ['bootstrap-icons/font/fonts/bootstrap-icons.woff2', 'fonts/bootstrap-icons.woff2'],
  ['bootstrap-icons/font/fonts/bootstrap-icons.woff', 'fonts/bootstrap-icons.woff'],
];

fs.rmSync(OUT, { recursive: true, force: true });

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = path.join(ROOT, 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.error(`vendor-assets: missing ${from} — run npm install first`);
    process.exit(1);
  }
  const dest = path.join(OUT, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  copied += 1;
}

console.log(`vendor-assets: copied ${copied} files into public/vendor/`);
