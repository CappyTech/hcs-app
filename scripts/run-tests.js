/**
 * Cross-platform test runner.
 *
 * `node --test tests/*.test.js` relies on shell glob expansion, which never
 * happens under cmd.exe on Windows (npm runs scripts through cmd), so the
 * runner hangs waiting on a literal glob pattern. This script enumerates the
 * test files itself and passes them to `node --test` explicitly.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);

const testsDir = path.join(__dirname, '..', 'tests');
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join('tests', f));

if (files.length === 0) {
  console.error('No test files found in', testsDir);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-force-exit', '--experimental-test-module-mocks', ...files], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

process.exit(result.status === null ? 1 : result.status);
