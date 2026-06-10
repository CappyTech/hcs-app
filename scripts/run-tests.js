/**
 * Cross-platform test runner.
 *
 * `node --test tests/*.test.js` relies on shell glob expansion, which never
 * happens under cmd.exe on Windows (npm runs scripts through cmd), so the
 * runner hangs waiting on a literal glob pattern. This script enumerates the
 * test files itself and passes them to `node --test` explicitly.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const testsDir = path.join(__dirname, '..', 'tests');
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join('tests', f));

if (files.length === 0) {
  console.error('No test files found in', testsDir);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...files], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

process.exit(result.status === null ? 1 : result.status);
