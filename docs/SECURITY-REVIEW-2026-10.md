# hcs-app security review — October 2026

**Scope:** hcs-app at commit `fe501677` (branch `feat/statement-reconcile`, version 6.71.0).

**Method:** static review of the whole codebase (authentication, sessions, 2FA, SSO, RBAC
and data scoping, CSRF, input handling, the generic CRUD/list query builders, file routes,
rate limiting and lockout, Helmet/CSP, secrets handling, and the KashFlow/Paperless/Microsoft
API clients), `npm audit`, and a small set of read-only, single-request HTTP checks against
`https://app.heroncs.co.uk`. No logins were attempted, no data was created or changed on the
live site, no automated scanner was run, and nothing was sent in volume. Where a check would
have been destructive it is described rather than performed.

**Authorisation:** requested by the application owner for their own system.

This document contains no customer, supplier or financial data, credentials or tokens. Line
numbers refer to the commit above and may drift as the code changes. Each finding gives the
location, why it matters, and the fix; it does not include a working exploit.

---

## 1. Summary

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| C1 | **Critical** | Unvalidated object values reach Mongoose query filters in the password-reset / email-verify lookups, enabling query-operator abuse against reset tokens | `mongoose/controllers/userCRUDController.js:465,737,762,785` |
| H1 | **High** | Employees/subcontractors can create attendance records for other people, with attacker-chosen status and pay fields, via the generic CRUD create route | `mongoose/config/CRUDControllerConfig.js:88-91`, `mongoose/controllers/CRUDController.js:526-660` |
| H2 | **High** | Rate limiting is keyed on a client-spoofable forwarded-IP header (confirmed live) | `services/ipService.js:104-114` |
| H3 | **High** | The login/forgot-password lookups pass the raw identifier object into a Mongoose `$or`, allowing operator abuse of the account lookup | `mongoose/controllers/userCRUDController.js:235,574-581` |
| M1 | Medium | Every unauthenticated request creates and persists a MongoDB session row (confirmed live) | `services/csrfService.js:55-92` |
| M2 | Medium | Password-reset and email-verification tokens arrive in the query string and are written to the app log | `services/logRequestDetailsService.js:116,143` |
| M3 | Medium | Weak password policy: no minimum length at registration, 6 characters elsewhere | `userCRUDController.js:79`, `:769`, `:860`, `:944`; `settingsController.js:621` |
| M4 | Medium | SMS reset OTP is generated with `Math.random` and the verify step has no per-account attempt limit | `userCRUDController.js:691`, `verifySmsOtp` |
| M5 | Medium | Generic CRUD update/delete are not ownership-scoped, `customPermissions` model grants bypass own-only scoping, and the per-model `validators` are never executed | `CRUDController.js:673-830`, `rolePermissionsConfig.js` `canAccess`, `authService.js` `ensureOwnership` |
| M6 | Medium | The hcs-sync SSO cookie is a long-lived, non-revocable JWT set on the shared parent domain | `mongoose/controllers/ssoController.js:156,196-210,384` |
| M7 | Medium | List/read query parameters can inject query operators; harmful here as result-broadening and regex denial-of-service rather than auth bypass | `mongoose/controllers/listController.js:90-125,195-210`, `CRUDController.js:~330` |
| L1 | Low | Upload type check trusts the client-supplied extension and MIME type only | `mongoose/routes/fileRoutes.js:19-27` |
| L2 | Low | The per-record document authorisation middleware looks up a model that never resolves, so file routes always 404 (fails closed, but the access check never actually runs) | `services/ensureCanAccessRecord.js:70`, `fileController.js:73,109`, `CRUDController.js:465` |
| L3 | Low | Socket.IO CORS reflects any origin with credentials enabled | `services/socketService.js:12-18` |
| L4 | Low | The scanner blocklist derives the client IP from the first `X-Forwarded-For` entry with no trust check | `services/requestBlocklistService.js:95-101` |
| L5 | Low | `/csp-report` is unauthenticated, unthrottled and logs attacker-controlled JSON | `app.js:208-224` |
| L6 | Low | The setup wizard uses a constant session secret and an Origin check that passes when the header is absent | `app.js:286`, `mongoose/routes/setupRoutes.js:12-23` |
| L7 | Low | Admin-authored option labels are emitted unescaped in one view | `mongoose/views/tailwindcss/attendance/weekly-excel.ejs:384,391` |
| L8 | Low | Legacy plaintext-password fallback is still accepted at login and at SSO token issue | `userCRUDController.js:~262`, `ssoController.js:~318` |
| L9 | Low | The flash cookie is written with `httpOnly: false` | `services/flashService.js:36-41` |
| I1 | Info | `npm audit`: 6 high, all in dev-only tooling (tailwindcss 3 / nodemon via `braces`) | `package.json` |
| I2 | Info | Controls that are working well (see §5) | — |

**Recommended fix order:** C1, H3 and M7 share one remedy (reject non-string values for
these parameters and turn on Mongoose's filter sanitisation), so do them together first.
Then H1, H2, M1, M2, then the rest.

---

## 2. Findings

### C1 — Critical: unvalidated objects reach the reset-token query filters

**Where:** `mongoose/controllers/userCRUDController.js`
- `resetPassword` (POST `/user/reset-password`): `token` is read from `req.body` (line 762)
  and placed directly into `findOne({ passwordResetToken: token, passwordResetExpires: { $gt: ... } })`
  (line 785).
- `renderResetPasswordForm` (GET, lines 737/745) and `verifyEmail` (GET `/user/verify-email`,
  lines 465/472) follow the same pattern.

**Why it matters:** Express with the default `qs` body/query parser turns
`token[<op>]=...` into a nested **object**, not a string. Mongoose accepts that object as a
query operator in the filter. Because the only secret guarding a reset is that single token
field, a filter that matches "any non-empty token that is still in date" can resolve to a
real pending-reset account without the attacker knowing the token value. The reset flow then
lets the request set a new password for whichever account comes back. The same shape applied
to `verifyEmail` lets an unverified account be confirmed without the emailed link. I confirmed
in a local Node/Mongoose/`qs` harness that the bracket syntax parses to an operator object and
that Mongoose casts the resulting filter without error; I did **not** send any such request to
the live site. The precondition is that at least one reset is pending, which an attacker can
cause for a known address via the public forgot-password form.

**Fix:**
- Coerce every token to a primitive before querying: `const token = String(req.body.token || '')`
  (and the same for `req.query.token`), rejecting empty strings. Do this in `resetPassword`,
  `renderResetPasswordForm` and `verifyEmail`.
- Defence in depth for the whole app: call `mongoose.set('sanitizeFilter', true)` at
  connection setup (`mongoose/services/mongooseDatabaseService.js`), which wraps user-supplied
  operator objects so they are treated as literals. Verify no legitimate query relies on
  passing operator objects through a top-level value (the controllers reviewed build their
  own `$gt`/`$or` explicitly, so this is safe).
- Consider storing only a hash of the reset token and looking it up by hash, so the stored
  value is never directly comparable.

---

### H1 — High: cross-user attendance creation with attacker-chosen pay via generic CRUD

**Where:** `mongoose/config/CRUDControllerConfig.js:88-91` grants attendance
`create: ['ensureRoles:admin,employee,subcontractor']`. The generated handler is
`crudController.createAttendance` in `mongoose/controllers/CRUDController.js:526-660`.

**Why it matters:** the self-service submission path (`attendanceController.submitAttendance`)
is careful: it forces `employeeId`/`subcontractorId` to the logged-in user and sets a safe
`type`. The generic `POST /attendance` route does none of that. The create handler takes the
request body, strips only `hideFields`, runs `beforeCreate` (a payroll-lock check), and saves.
It does **not** restrict `employeeId`/`subcontractorId` to the caller, and it does not force
`status`. An employee or subcontractor can therefore create an `approved` attendance record
naming another worker, with an arbitrary `dayRate`/`payRate`/`hoursWorked`. Because approved
attendance feeds payroll, this is a financial-integrity and data-integrity issue, not just a
nuisance. The per-model `validators` block in the config is not enforced (see M5), so even the
value checks there do not apply.

**Fix:**
- Remove `employee` and `subcontractor` from the generic attendance `create` middleware and
  route these roles only through `submitAttendance`, which already scopes ownership and status.
- If the generic route must stay open to them, add a `beforeCreate` hook (the mechanism already
  exists) that: forces the owner field to `req.user.employeeId`/`subcontractorId`, rejects a
  mismatch, and forces `status: 'pending'` for non-admins.
- Longer term, give the CRUD create engine the same ownership enforcement the read path has
  (see M5): own-only roles may only create records whose owner field equals their linked entity.

---

### H2 — High: rate limiting keyed on a spoofable IP header (confirmed)

**Where:** `services/ipService.js:104-114`. When the direct peer is a trusted proxy,
`getClientIp` returns the first of `cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`,
`forwarded`. This value is the key for the global limiter, the registration limiter, the SSO
and login limiters, and the account-lockout audit IP.

**Why it matters:** the deployment sits behind frp, and app.js trusts the `172.16.0.0/12`
bridge range, so inbound requests arrive from a trusted-proxy peer and these headers are
honoured. There is no Cloudflare in front of the app (no `CF-*` normalisation upstream), so a
client can send `CF-Connecting-IP` itself. A different value per request gives each request its
own limiter bucket, defeating the 1500/15-min global limit, the 10/15-min registration limit,
and the per-IP portion of brute-force defences. **Confirmed live, read-only:** a request with
`CF-Connecting-IP: <fixed test value>` returned `RateLimit-Remaining: 1499` (its own fresh
bucket) while unheadered requests continued counting down a shared bucket. I sent single
requests only and did not attempt to exhaust any limit.

**Fix:**
- Trust forwarded client-IP headers **only** when they come from an infrastructure you control
  that is known to set them. Since the real edge here is frp (not Cloudflare), do not consult
  `cf-connecting-ip` at all, and prefer Express's own `req.ip` computed from `trust proxy`
  rather than re-parsing `x-forwarded-for`.
- If a specific header must be honoured, strip it at the Caddy/frp edge for inbound requests
  and re-set it there, so a client value can never survive to the app.
- Account lockout (`loginAttempts`/`lockedUntil`) is keyed on the account, not the IP, so it
  still works; but the IP recorded in the audit trail is attacker-controlled today.

---

### H3 — High: operator injection in the login / forgot-password identifier

**Where:** `mongoose/controllers/userCRUDController.js:235` (`loginUser`) and `:574-581`
(`sendPasswordReset`), both building `findOne({ $or: [{ username: ... }, { email: ... }] })`
from the raw request field.

**Why it matters:** as in C1, a bracketed body field parses to an operator object. In the login
path this does not by itself grant a session (the password check still runs with `bcrypt.compare`
against whatever user is returned, and that returns false for a crafted password), so it is not
a direct bypass. It does let an unauthenticated caller select an account by criteria rather than
by name and drive its failed-attempt counter, locking out an account the attacker cannot name.
In `sendPasswordReset` it lets the caller steer which account a reset is issued for.

**Fix:** coerce `usernameOrEmail` to a string at the top of both handlers before building the
query, and rely on the app-wide `sanitizeFilter` from C1. Reject non-string credentials with
the same generic error used for a bad login.

---

### M1 — Medium: anonymous requests create persistent sessions (confirmed)

**Where:** `services/csrfService.js:55-92`. The middleware sets `req.session.csrfToken` and
calls `req.session.save()` on the first request of any visitor. `express-session` is configured
with `saveUninitialized: false` (`mongoose/services/sessionService.js`), but writing to the
session makes it "modified", so it is persisted and a `__Host-hms.sid` cookie is issued.

**Why it matters:** every unauthenticated hit — including every blocked scanner probe that still
reaches this middleware — writes a row to the `sessions` collection and sets a cookie.
**Confirmed live:** each read-only GET to `/`, `/user/login`, etc. returned a fresh
`Set-Cookie: __Host-hms.sid=...`. This is a storage-growth and denial-of-service amplifier (an
unauthenticated flood fills the session store) and makes the session table noisy for the admin
session list. TTL cleanup exists, but the write amplification is the concern.

**Fix:** only create the CSRF token when a session already exists, or when the request is one
that will render a form, rather than on every request. A common pattern is to generate the token
lazily inside the view helper / on authenticated sessions, and to skip `session.save()` for
requests that have no `req.session.user` and are not a form GET. At minimum, do not force a save
for anonymous GETs.

---

### M2 — Medium: reset / verification tokens logged

**Where:** `services/logRequestDetailsService.js:116,143` logs
`sanitize(req.originalUrl)` for `/` and auth routes. `renderResetPasswordForm` and `verifyEmail`
receive their token in the query string (`?token=...`), so the full token lands in
`logs/app.json.log`, which is also streamed to admins over the log WebSocket and downloadable
at `/logs/download`.

**Why it matters:** a reset token in a log is a bearer credential. Anyone who can read the logs
(admins, anyone with filesystem or log-stream access, or a log-exfil bug) can complete a reset
or verify an email within the token's validity window.

**Fix:** move these tokens out of the URL (POST the token in the body, or exchange it for a
short-lived session-bound value on GET), or redact a `token` query parameter in
`logRequestDetailsService` before logging the URL. The existing `sanitize` only strips control
characters; add a query-string scrubber for known-sensitive keys (`token`, `code`, `otp`).

---

### M3 — Medium: weak password policy

**Where:** registration (`userCRUDController.js:79`) applies the breach check but **no length
or complexity rule at all**. Reset and change-password paths enforce only `>= 6`
(`:769`, `:860`, `:944`; `settingsController.js:621`).

**Why it matters:** a six-character minimum and no registration minimum is well below current
guidance (NCSC/NIST suggest a 8–12 minimum with breach screening). The HIBP breach check is a
good control but does not substitute for a length floor.

**Fix:** enforce a consistent minimum (12 recommended) in `validateChangePassword`, the reset
handlers, and registration. Keep the HIBP check. Centralise the rule in one validator so all
paths share it.

---

### M4 — Medium: predictable SMS OTP and no verify throttle

**Where:** `userCRUDController.js:691`: `String(Math.floor(100000 + Math.random() * 900000))`.
`verifySmsOtp` checks the submitted OTP against the stored one with no per-account failure
counter.

**Why it matters:** `Math.random` is not cryptographically secure, so the OTP is more
predictable than it looks. More importantly, a 6-digit code with no attempt limit and a 10-minute
window is brute-forceable (the global rate limit is the only brake, and that is bypassable per
H2). This is a password-reset channel.

**Fix:** generate the OTP with `crypto.randomInt(0, 1_000_000)` and zero-pad. Add an attempt
counter on the reset (reuse the `loginAttempts`/`lockedUntil` style) and invalidate the OTP after
a few failures. Consider shortening the window.

---

### M5 — Medium: generic update/delete not ownership-scoped; custom grants unscoped; validators dead

**Where:** `mongoose/controllers/CRUDController.js:673-830`. The `read` handler enforces
ownership for own-only roles (lines 263-289), but `update` and `delete` do **not** — they fetch
and mutate by `uuid` alone. Access to reach those handlers is governed by the per-model
`middleware`, which for most models is admin-only, so this is currently contained. Two gaps make
it worth fixing:
- Any model whose config grants a non-admin role `update`/`delete` (today, or in future config
  edits) immediately becomes cross-user writable, because the handler itself has no ownership
  backstop.
- `rolePermissionsConfig.canAccess` returns `ownOnly: false` for every `customPermissions.models`
  grant (by design, lines in `canAccess`). So an admin granting a user a per-model permission
  silently grants it unscoped — across all records, not the user's own.
- The `validators` objects in `CRUDControllerConfig.js` (e.g. attendance, user) are never called
  by the create/update handlers; only Mongoose schema validation runs. Rules expressed there
  (status enums, numeric ranges) are not enforced.

**Why it matters:** the design leans entirely on the route middleware being correct for every
model, with no second layer in the controller. That is fragile, and it interacts with H1.

**Fix:** mirror the read-path ownership check into `update` and `delete` (reuse `scopeQuery`
and verify the fetched record matches before mutating). Decide deliberately whether
`customPermissions` grants should be own-scoped and implement it. Either wire the config
`validators` into the create/update flow or delete them so they do not read as active controls.

---

### M6 — Medium: long-lived, non-revocable SSO cookie on the parent domain

**Where:** `mongoose/controllers/ssoController.js`. `hcsSyncHandoff` signs an HS256 JWT with
default TTL `60*60*8` (8 hours, line 156) and sets it as `hcs_sso` on a derived parent domain
(`.heroncs.co.uk`, lines 196-210) so sync.heroncs.co.uk can read it. The compose example suggests
`HCS_SSO_TTL_SECONDS=3600` but the code default is 8 hours.

**Why it matters:** a stateless JWT cannot be revoked before expiry. On a shared parent domain,
any sibling subdomain on `heroncs.co.uk` can read the cookie. Eight hours is a long window for a
bearer token that grants access to the financial sync dashboard, and logout in hcs-app does not
invalidate it.

**Fix:** shorten the TTL to match the documented 1 hour (or less) and set `HCS_SSO_TTL_SECONDS`
explicitly. Prefer scoping the cookie to the exact sync host rather than the parent domain if no
other sibling needs it. Consider a short TTL plus silent re-issue, or a server-side revocation
list keyed on the `jti` already being minted, so logout can invalidate outstanding tokens.

---

### M7 — Medium: operator/regex injection via list and read query parameters

**Where:** `mongoose/controllers/listController.js` builds filters from `req.query` (search,
tabs, `f_*` filters, sort). Search terms are regex-escaped (lines ~199, ~629), which is good,
but filter and tab values are placed into the filter as-is, and the per-field filter builder
(lines 90-125) does not coerce types. The supplier read view (`CRUDController.js` around line
330) builds date ranges from `req.query.from`/`to`.

**Why it matters:** these paths are authenticated and already pass through `scopeQuery`, which is
`$and`-combined on top (lines 294-305), so an injected operator **cannot** widen past the
ownership filter — this is not an authorisation bypass. The realistic harm is result-broadening
within what the user may already see, and regex denial-of-service where a value reaches a
`$regex` without escaping. Lower severity than C1/H3 because scoping holds.

**Fix:** the app-wide `sanitizeFilter` from C1 covers most of this. In addition, coerce `f_*`
filter values and tab values to the expected primitive type before use, and ensure any value
that becomes a `$regex` is escaped (the search path already does this; audit the tab/filter
paths for parity).

---

### L1 — Low: upload validation trusts client extension and MIME

**Where:** `mongoose/routes/fileRoutes.js:19-27` (and the bank/website uploaders) accept a file
when the client-supplied extension and `file.mimetype` match an allowlist.

**Why it matters:** both are attacker-controlled. Files are stored outside the web root and served
only through authenticated download routes with `X-Content-Type-Options: nosniff` elsewhere, which
limits impact, but content-type is not verified against the bytes.

**Fix:** verify magic bytes (e.g. with `file-type`) after upload, and set a `Content-Disposition:
attachment` / correct `Content-Type` with `nosniff` on the document view/download responses in
`fileController` (the Paperless OCR file route already sets `nosniff`; the generic file routes do
not).

---

### L2 — Low: per-record document authorisation never actually runs (fails closed)

**Where:** `services/ensureCanAccessRecord.js:70` does `const model = mdb[modelName]`, but models
live under `mdb.REST` / `mdb.INTERNAL` / `mdb.PAPERLESS`, not at the top level. The same mistake
is in `fileController.js:73,109` (`mdb[modelName]`, `mdb[`${modelName}_files`]`) and
`CRUDController.js:465` (reads documents from `public/<model>/...`, a directory the storage
refactor abandoned).

**Why it matters:** the lookup returns `undefined`, so `ensureCanAccessRecord` returns a 404 for
every file request. The routes therefore fail closed (no data leaks), but the intended
per-record access check is dead code, and the document view/upload/download features appear not
to work at all through these routes. This is both a latent authz gap (if the lookup is "fixed"
without re-checking the logic) and a broken feature.

**Fix:** resolve the model through the namespaces (as `ensureHandlesDocuments` and other code do:
try `mdb.REST[name] || mdb.INTERNAL[name] || mdb.PAPERLESS[name]`). Add a test that a non-owner is
refused a document on a record they do not own, so the check is exercised. Align
`CRUDController.js:465` with the real storage location in `services/fileStorage.js`.

---

### L3 — Low: Socket.IO CORS reflects any origin with credentials

**Where:** `services/socketService.js:12-18`: `cors: { origin: true, credentials: true }`.

**Why it matters:** `origin: true` reflects the requesting origin and allows credentials. The
WebSocket handshake still requires a valid authenticated session and admin role
(`webSocketService.js`), so this is not a direct data leak, but a permissive CORS posture on a
credentialed socket is unnecessary.

**Fix:** set `origin` to the app's own origin(s) explicitly.

---

### L4 — Low: blocklist IP parsed from untrusted `X-Forwarded-For`

**Where:** `services/requestBlocklistService.js:95-101` takes the first `x-forwarded-for` entry
directly, without the trusted-proxy check that `ipService` applies.

**Why it matters:** the autoban counter and ban map are keyed on this value, so a client can spoof
it to avoid its own ban or to attribute probes to an arbitrary IP. Fail-open design means this
never blocks legitimate traffic, but the ban feature is evadable.

**Fix:** reuse `getClientIp(req)` (after H2 is fixed) so one trusted-IP policy governs both rate
limiting and the blocklist.

---

### L5 — Low: `/csp-report` unauthenticated, unthrottled, logs attacker JSON

**Where:** `app.js:208-224`. The endpoint accepts up to 32 KB of JSON from anyone and logs up to
2 KB of it at warn level.

**Why it matters:** browsers must be able to POST reports without auth, so some exposure is
inherent, but there is no rate limit and the body is attacker-controlled, so it is a log-flooding
and log-injection vector (the content is `JSON.stringify`-ed, which limits injection, but volume
is unbounded).

**Fix:** add a tight rate limiter to this route, cap how much is logged, and consider sampling.

---

### L6 — Low: setup wizard constant secret and weak Origin check

**Where:** `app.js:286` mounts a session with `secret: 'setup-wizard-temporary-secret'` while the
app is unconfigured; `mongoose/routes/setupRoutes.js:12-23` guards POSTs with an Origin check that
only triggers when the `Origin` header is present (`if (origin && ...)`).

**Why it matters:** the wizard only runs before first configuration (and sets the first admin), so
the window is short and normally local. Still, a constant session secret is predictable, and a
missing `Origin` header skips the CSRF-style check entirely.

**Fix:** generate a random wizard secret at boot, and treat a missing `Origin` on a POST as a
failure (or additionally check `Referer`/`Sec-Fetch-Site`). Ensure the wizard cannot be reached
once configured (it already returns early when `configService.isConfigured()`).

---

### L7 — Low: unescaped admin-authored labels in one view

**Where:** `mongoose/views/tailwindcss/attendance/weekly-excel.ejs:384,391` build `<option>`
elements with `<%- ... l.name ... %>` / `c.title` (unescaped) from location and contract records.

**Why it matters:** these names are admin-entered, so this is stored-XSS only if a lower-privileged
user can set a location/contract name that an admin then views — currently those are admin-managed,
so exposure is limited. Most other `<%-` usages reviewed are safe (helper-generated HTML, or values
passed through an explicit HTML-escape).

**Fix:** switch to `<%= %>` for these names, or build the options server-side with escaping.

---

### L8 — Low: legacy plaintext-password fallback still accepted

**Where:** `userCRUDController.js` login (around line 262) and `ssoController.js` `issueTokenForSync`
(around line 318) compare the submitted password against the stored value directly when it does not
look like a bcrypt hash, then upgrade it.

**Why it matters:** this is a one-time migration aid, but as long as it is present a plaintext
password stored by any means is honoured. If all stored passwords are now bcrypt, this branch is
dead weight that weakens the invariant "we only ever compare hashes."

**Fix:** once you confirm no plaintext passwords remain (a quick DB check for values not starting
with `$2`), remove the fallback and reject non-hashed stored passwords.

---

### L9 — Low: flash cookie readable by script

**Where:** `services/flashService.js:36-41` sets `__flash` with `httpOnly: false`.

**Why it matters:** flash messages are not secrets, so impact is low, but there is no reason for
client script to read this cookie; it is read server-side on the next request.

**Fix:** set `httpOnly: true` (and `sameSite: 'lax'`, `secure` per environment).

---

## 3. Dependency audit (I1)

`npm audit` reports **6 high** advisories, all stemming from `braces` (ReDoS) pulled in through
`micromatch`/`chokidar`/`fast-glob` under **tailwindcss 3** and **nodemon** — both dev/build-only
dependencies, not shipped in the production image (`npm ci --omit=dev`). No production runtime
dependency is flagged. Installed production libraries are current: express 4.22.3, helmet 7.2.0,
mongoose 8.24.1, jsonwebtoken 9.0.3, multer 2.4.0, bcrypt 6.0.0, socket.io 4.8.1.

**Fix:** the only clean resolution is the tailwindcss 4 major upgrade (`fixAvailable` is
`tailwindcss@4.3.3`, a breaking change) plus a nodemon bump. Since these are build-time only, the
runtime risk is minimal; schedule the tailwind 4 migration rather than rushing it. Keep running
`npm audit` in CI so a future production-dependency advisory is noticed.

---

## 4. Live read-only checks (results)

All single-request, non-destructive, against `https://app.heroncs.co.uk`:

- **Security headers** present and strong on every response, including error and 403 responses:
  HSTS (`max-age=15552000; includeSubDomains`), a tight CSP (nonce-based script/style, no
  `unsafe-inline`), `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, a comprehensive `Permissions-Policy`, and
  `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy`.
- **Session cookie** is `__Host-hms.sid` with `HttpOnly; Secure; SameSite=Lax; Path=/` — a strong
  configuration.
- **`x-powered-by`** is suppressed.
- **HTTP → HTTPS** redirect is a 308 to the HTTPS origin.
- **Protected routes** (`/employees`, `/admin/config`, `/logs`, `/paperless/ocr`,
  `/__debug/headers`) redirect unauthenticated users to `/user/login` — no content leaked.
- **Machine endpoints** reject correctly: `POST /api/paperless/webhook` → 401 without the secret,
  `POST /api/sso/token` → 401 without the API key, `GET /api/web/content` → 401 without the bearer
  token, `POST /user/login` without a CSRF token → 403.
- **Scanner blocklist** returns 403 for `/.env`, `/wp-admin`.
- **`/healthz`** returns 403 to non-loopback callers, as intended.
- **TLS 1.1** handshake is refused.
- **Rate-limit key spoofing (H2)** confirmed: a request carrying a client-set `CF-Connecting-IP`
  received its own fresh limiter bucket.
- **Anonymous session creation (M1)** confirmed: every anonymous GET returned a new
  `Set-Cookie: __Host-hms.sid`.

---

## 5. What is working well (I2)

- Response security headers, CSP (nonce-based, no `unsafe-inline`), HSTS and the `__Host-` session
  cookie are all strong and applied even to early 403/503 responses.
- CSRF is session-token based, timing-safe, body/header only (never query string), strict by
  default, with a correct multipart-deferred validation pattern.
- Passwords are bcrypt (12 rounds) with HIBP breach screening; TOTP secrets are AES-256-GCM at
  rest; account lockout is account-keyed (so it survives the H2 IP issue).
- Session is regenerated on login and 2FA completion (fixation protection).
- The machine-to-machine endpoints (SSO token, Paperless webhook, web content API) use
  timing-safe secret comparison and fail closed when unconfigured.
- RBAC is centralised, with route/department/model layers and a read-path ownership check; the
  2FA-required-roles and auditor-is-read-only design is thoughtful.
- The dev-only Mongo inspector is triple-gated (env flag + non-production + loopback) and the
  file store was deliberately moved out of the web root.
- External API clients strip `Authorization` before logging, and the KashFlow/Paperless API log
  redacts request/response bodies.

---

*Review performed 2026-10-16 against commit `fe501677`. Findings are point-in-time; re-run
`npm audit` and these header checks after fixes land.*
