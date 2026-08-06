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

// NB: no `--test-force-exit`. It forces the process down as soon as the runner
// believes it is finished, which races the slower test files still reporting
// their results — they were silently dropped from the run, not failed. The
// visible symptom was a test count that wandered between 1,037 and 1,086
// across runs while always reporting success, so up to 49 tests could vanish
// without a trace and a regression in them would never surface. `tests/bankViews.test.js`
// (39 tests) was the usual casualty; it is deterministic in isolation.
//
// The flag is normally a workaround for a leaked handle keeping the process
// alive. There isn't one here: without it the suite exits 0 on its own in
// ~1.6s. If a hang ever appears, find the open handle rather than reinstating
// this — the cure hid 5% of the suite.
const result = spawnSync(process.execPath, ['--test', '--experimental-test-module-mocks', ...files], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' },
});

process.exit(result.status === null ? 1 : result.status);
