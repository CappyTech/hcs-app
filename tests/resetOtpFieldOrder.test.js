import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const VIEWS = 'mongoose/views/tailwindcss/user';

// One-time codes expire: 30s for an authenticator, 10 minutes for the SMS OTP.
// If the code field comes first, everything typed after it — two password fields,
// a confirmation, then reaching for the button — burns that window, and a code that
// was valid when it was read off the phone can be rejected by the time it is posted.
// The code must therefore be the last field before submit on every reset view.
const CODE_LAST = [
  { view: 'verify-totp-reset.ejs', code: 'totpToken' },
  { view: 'verify-sms-otp.ejs', code: 'otp' },
];

describe('password reset — one-time code field ordering', () => {
  for (const { view, code } of CODE_LAST) {
    it(`${view} asks for the passwords before the code`, () => {
      const html = read(path.join(VIEWS, view));

      const codeAt = html.indexOf(`name="${code}"`);
      const passwordAt = html.indexOf('name="password"');
      const confirmAt = html.indexOf('name="confirmPassword"');
      const submitAt = html.indexOf('type="submit"');

      assert.ok(codeAt > -1, `${code} field is missing`);
      assert.ok(passwordAt > -1 && confirmAt > -1, 'password fields are missing');
      assert.ok(submitAt > -1, 'submit button is missing');

      assert.ok(
        passwordAt < codeAt,
        `the new password field must come before ${code}`,
      );
      assert.ok(
        confirmAt < codeAt,
        `the confirm password field must come before ${code}`,
      );
      assert.ok(
        codeAt < submitAt,
        `${code} must be the last field before the submit button`,
      );
    });

    it(`${view} keeps the one-time-code autofill hint on ${code}`, () => {
      // Moving the field must not cost the browser/OS autofill of an incoming code.
      const html = read(path.join(VIEWS, view));
      // The tag closes on a line of its own; do not stop at the first ">", which
      // now belongs to an embedded EJS tag.
      const field = html.slice(html.indexOf(`name="${code}"`));
      const end = field.search(/^\s*>\s*$/m);
      assert.ok(end > -1, 'could not find the end of the code input tag');
      assert.match(field.slice(0, end), /autocomplete="one-time-code"/);
    });
  }

  for (const { view } of CODE_LAST) {
    it(`${view} repopulates both password fields from the draft`, () => {
      // A rejected code must not also cost the user the passwords they typed.
      const html = read(path.join(VIEWS, view));
      // Escaped output only — a password interpolated with <%- would be an XSS sink.
      assert.match(html, /value="<%= locals\.draft && draft\.password \|\| ''\s*%>"/);
      assert.match(html, /value="<%= locals\.draft && draft\.confirmPassword \|\| ''\s*%>"/);
      assert.ok(!/<%-\s*draft/.test(html), 'draft values must never be interpolated unescaped');
    });

    it(`${view} focuses the code field when the passwords came back filled in`, () => {
      const html = read(path.join(VIEWS, view));
      assert.match(html, /<% if \(!\(locals\.draft && draft\.password\)\) { %>autofocus/);
      assert.match(html, /<% if \(locals\.draft && draft\.password\) { %>autofocus/);
    });
  }

  it('login keeps the same order — password, then 2FA code', () => {
    const html = read(path.join(VIEWS, 'login.ejs'));
    assert.ok(
      html.indexOf('name="password"') < html.indexOf('name="totp"'),
      'login must ask for the password before the 2FA code',
    );
  });
});
