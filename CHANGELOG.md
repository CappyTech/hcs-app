# Changelog

All notable changes to hcs-app will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [6.6.15] - 2026-06-24

### Changed
- **`twoFAController`**: replaced silent `try/catch` around the session denorm write with a fire-and-forget `.catch()` that logs a warning. The intent was always best-effort; the swallowed catch was just noise hiding failures silently.

## [6.6.14] - 2026-06-24

### Fixed
- **`/user/2fa` redirect loop for logged-in users**: visiting `/user/2fa` with an active session now redirects to `/` instead of showing "2FA session expired".

## [6.6.13] - 2026-06-24

### Fixed
- **Inline 2FA on login page**: the `totp` field submitted on `/user/login` was previously ignored — the controller always redirected TOTP-enabled accounts to `/user/2fa`. Now, if a code is provided upfront it is verified immediately (including backup code fallback), and on success the session is created directly. If no inline code is provided the existing staged-login redirect to `/user/2fa` still applies.

## [6.6.12] - 2026-06-24

### Fixed
- **2FA login returned a bare "Not Found" on code submission** — the real root cause behind the long-running 2FA failure (6.6.1/6.6.8/6.6.9 addressed adjacent issues but not this one). `CRUDRoutes` auto-generates `POST /:model/:uuid` for each model's update action, including `POST /user/:uuid`. `POST /user/2fa` matched it with `uuid="2fa"`, and the `router.param("uuid")` guard returned `404 "Not Found"` instead of falling through — shadowing the real `POST /user/2fa` handler in `twoFARoutes` (mounted afterwards). The guard now calls `next("route")` so non-UUID params skip the CRUD route and reach the correct handler. This also un-shadows any other specific route sharing a `/:model/<segment>` shape. (`GET /user/2fa` was never affected — CRUD only generates `GET /:model/read|update/:uuid`.)

## [6.6.11] - 2026-06-24

### Fixed
- **Footer commit SHA was blank in deployed images**: the 6.6.10 footer feature had no value to show because CI built the image without the `GIT_COMMIT` build arg, and the container has no `.git` to fall back on. CI now passes `SHORT_SHA` as the build arg (`.github/workflows/ci.yml`); `app.js` displays a 7-char SHA regardless of input length. (Manual builds still need `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)`.)

## [6.6.10] - 2026-06-24

### Added
- **Build commit in footer**: the footer now shows the short Git commit SHA next to the version, linking to the commit on GitHub. The SHA is baked into the image via a `GIT_COMMIT` build arg, with a local-dev fallback that reads git directly; the repo URL is overridable via `GIT_REPO_URL`.

### Fixed
- **Dashboard "Two-Factor Auth" tile** linked to `/user/2fa` — the pre-login challenge, which only works mid-login and otherwise bounces a logged-in user to the login page. It now points to `/user/account`, where 2FA setup and management actually live.

## [6.6.9] - 2026-06-23

### Fixed
- **2FA login flow**: added `/user/2fa` to `PUBLIC_PATHS` in `authService`. The global `ensureAuthenticated` middleware runs before route handlers, so it was intercepting the 2FA page and redirecting unauthenticated mid-login users back to `/user/login`. The controller already validates `req.session.userPending2FA` so the route is safe without a session guard.

## [6.6.8] - 2026-06-23

### Fixed
- **2FA login flow**: removed `ensureAnyRole()` guard from `GET /user/2fa` and `POST /user/2fa` routes. Users at the 2FA step only have `req.session.userPending2FA` (not a full session), so the middleware was rejecting them with a 401 before the controller could run. The controller already validates the pending session itself.

## [6.6.7] - 2026-06-22

### Changed
- **compose.env.example**: documented all previously undocumented environment variables found in application code. Added a Tailscale section (`TS_AUTHKEY`, `TS_HOSTNAME`), SSO token lifetime (`HCS_SSO_TTL_SECONDS`), security rate-limiting variables (`BCRYPT_ROUNDS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MS`, `BLOCK_HIT_THRESHOLD`, `BLOCK_HIT_WINDOW_MS`, `BLOCK_BAN_TTL_MS`, `BLOCKED_IPS`), and miscellaneous variables (`HIBP_DISABLED`, `REQUIRE_2FA_ROLES`, `NOTIFY_EMAIL`).

## [6.6.6] - 2026-06-22

### Added
- **Tailscale integration**: `tailscaled` (userspace networking) is now baked into the production image via `docker-entrypoint.sh`. If `TS_AUTHKEY` is set, the container authenticates to the tailnet on startup and accepts routes, giving the app access to any service reachable over Tailscale (e.g. internal databases). If `TS_AUTHKEY` is absent the entrypoint is a no-op and the app starts normally.
- **docker-compose.yml / docker-compose.local.yml**: added a `tailscale` sidecar service (`tailscale/tailscale:latest`, userspace networking). The `hcs-app` container joins the sidecar's network namespace via `network_mode: service:tailscale`, routing all outbound traffic through Tailscale. The `tailscale_state` volume persists authentication state across restarts. Note: Caddyfile upstream must reference `tailscale:${PORT}` rather than `hcs-app:${PORT}`.
- **CI (`.github/workflows/ci.yml`)**: added optional `tailscale` workflow dispatch input (boolean, default `false`). When enabled, the runner joins the tailnet via the `tailscale/github-action@v3` step using OAuth credentials (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_CLIENT_SECRET`) tagged `tag:ci-hcs-app`, allowing builds to reach internal services.

## [6.6.5] - 2026-06-22

### Fixed
- **Dockerfile**: removed `# syntax=docker/dockerfile:1` directive. BuildKit on current GitHub Actions runners bundles a sufficiently recent frontend, so the directive was adding an unnecessary Docker Hub auth dependency that caused build failures when Docker Hub's token endpoint was unavailable (transient 520 errors).

## [6.6.4] - 2026-06-22

### Fixed
- **Layout**: removed stray `<br>` tag between `<main>` and the footer/nav block, which was adding an extra line of height to the page flow and could cause a spurious scrollbar at certain viewport sizes.

## [6.6.3] - 2026-06-22

### Changed
- **Login page**: added TOTP field (accounts with 2FA enrolled can optionally submit their code upfront); added `autofocus`, `autocomplete="username"`, `autocomplete="current-password"` attributes; submit button gains `focus:ring` classes for keyboard accessibility parity with hcs-sync.
- **Login page**: `SKIP_TURNSTILE` bypass check moved from template (`process.env.*`) to controller — `skipTurnstile` is now passed as a template variable. Turnstile script always loads unconditionally.

## [6.6.2] - 2026-06-22

### Security
- **nodemailer upgraded to 9.0.1**: fixes [GHSA-p6gq-j5cr-w38f](https://github.com/advisories/GHSA-p6gq-j5cr-w38f) (high) — the `raw` message option could bypass `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and SSRF. No application code changes required; `createTransport`/`sendMail` API is unchanged.

## [6.6.1] - 2026-06-22

### Fixed
- **2FA login broken**: `req.session.userPending2FA` was written to the session but `session.save()` was never awaited before redirecting to `/user/2fa`. The session store did not flush in time, causing every 2FA-enabled login to land on "2FA session expired. Please log in again." (`userCRUDController`).

## [6.6.0] - 2026-06-12

### Added
- **Bank-holiday auto-sync**: the existing GOV.UK feed import (`holidayService.syncBankHolidays`, previously never invoked) now runs as the weekly `bank-holiday-sync` job, keeping the Government Holidays list populated automatically.
- **HR expiry reminders** (`hrComplianceService` + daily `hr-compliance` job): tasks for admins and a daily summary email when an employee's contract end date or right-to-work check is expired/expiring within 30 days. New `employee.rightToWork` fields (documentType, reference, checkedDate, expiryDate) editable via the employee form. Certification tracking remains on the backlog.
- **Policy review reminders**: `policyDocument.reviewDate` (new field on the policy form, with an overdue badge on the list) + daily `policy-review-reminder` job emailing admins a summary of policies due/overdue for review.
- **Holiday carry-over at year end** (`holidayCarryOverService` + daily `holiday-carry-over` job): rolls unused entitlement from the previous holiday year into the current year's `carryOverDays`/`carryOverHours`, capped by each employee's `holidayPolicy.carryOverMax*` (default 0 = no carry-over). Applied once per year per employee (`carryOverAppliedAt`); manual carry-over values are never overwritten.
- **UK tax-ID format validation** (`ukTaxIdService`): UTR (10 digits), NINO (HMRC prefix/suffix rules), and CIS verification number (V + 10 digits + up to 2 letters) checked at entry — the supplier CIS details form (HMRC references, stored normalised) and the employee payroll NI number.
- 44 new unit tests; suite now at 571.

### Security
- **Per-role 2FA enforcement**: users with roles in `REQUIRE_2FA_ROLES` (default `admin,accountant`; empty string disables) must enable TOTP — until then they are confined to the account page, which shows a setup notice.
- **Breached-password check** (`hibpService`): new passwords are checked against Have I Been Pwned via the k-anonymity range API (only the first 5 SHA-1 chars leave the server) on registration, password change, and all three reset flows. Fails open on API outage; `HIBP_DISABLED=true` opts out.
- **Log out all other sessions**: one-click revoke of every other session from Account Settings (covers legacy session docs), audited as `sessions_revoked`.
- **Mongo-backed rate limiter** (`rateLimitMongoStore`): rate-limit counters now persist in the INTERNAL database (TTL-indexed `rateLimits` collection), surviving container restarts and shared across replicas. Fails open while MongoDB is down.
- **CSP violation reporting**: `report-uri /csp-report` directive + unauthenticated report endpoint that logs browser CSP violation reports.

## [6.5.0] - 2026-06-11

### Added
- **Central job scheduler** (`jobSchedulerService` + `jobRegistry`): all periodic work (session cleanup, vehicle compliance, OCR orphans, plus the new jobs below) now runs through one scheduler with per-job status, concurrency guards, and failure tracking. New admin page **/admin/jobs** shows status and lets admins trigger any job manually.
- **Notification service** (`notificationService` + INTERNAL `notification` outbox model): features enqueue emails into a persistent outbox; a worker job delivers them with exponential-backoff retry (5 attempts), so SMTP outages can't lose messages. Dedupe keys make recurring reminders idempotent. Outbox health (pending/sent/failed) is shown on /admin/jobs.
- **Holiday request workflow**: new `holidayRequest` model (request → approve/reject with reviewer trail), wired into the generic CRUD UI at /holidayRequests with status tabs. Admins are emailed on new requests; employees are emailed on decisions. Approving annual leave updates `employeeHoliday.takenDays` for the covering period (and reverses if un-approved). Employees can submit/view their own requests (`c:own,r:own,l:own`).
- **CIS return reminders**: emails admin/accountant users 7 and 2 days before each CIS monthly-return deadline (19th), with the tax period spelled out.
- **GDPR deadline tracking**: daily job alerts admins when an open data-subject request enters the 7-day warning window or passes its 30-day statutory deadline (one email per request per stage).
- **Fleet compliance emails**: the vehicle compliance check now also emails admins a daily summary of newly flagged MOT/insurance/road-tax items (in-app tasks unchanged).
- **Security audit log**: new INTERNAL `securityEvent` model (13-month TTL) + `auditLogService`. Records login success/failure, account lockouts, logouts, password changes/resets, 2FA enable/disable, backup-code regeneration, role and email changes, and SSO token issue/denial. New admin page **/admin/security-events** with type filtering and pagination.
- **Runtime maintenance toggle**: new admin page **/admin/maintenance** turns maintenance mode on/off without a restart (persists via app-config.json; blocked when MAINTENANCE is compose-managed) and sets a pre-announcement banner shown to all users. Admins see a persistent "maintenance is ON" reminder banner.
- **2FA backup codes**: enabling TOTP now issues 10 single-use recovery codes (shown once, stored bcrypt-hashed). The 2FA login accepts a backup code as fallback and consumes it; codes can be regenerated from Account Settings (password-confirmed, audited).
- **Connection test buttons**: /admin/connections sub-pages (KashFlow, SMTP, Paperless, Twilio) gained "Test connection" buttons that exercise the saved credentials live (SMTP verify, Paperless API call, KashFlow session, Twilio account fetch).
- **CSV export on list views**: every list page has a CSV button exporting the current view (search/tab/filters/scoping preserved, unpaged up to 10k rows, Excel-friendly BOM).
- **Duplicate purchase detection**: sending a Paperless draft to KashFlow is blocked when a purchase with the same supplier + supplier reference already exists in synced data, with an explicit per-send override checkbox.
- **Attendance payroll locking**: once a payroll run covering a date is locked/submitted, non-admin attendance submissions and edits for that date are rejected (self-service, inline editor, and CRUD paths).
- **Deleted-items auto-purge** (off by default): optional `DELETED_ITEMS_RETENTION_DAYS` (min 30) enables a daily job that permanently removes soft-deleted records past retention.
- **Generic CRUD hooks**: `CRUDControllerConfig` entries can now declare `afterCreate(doc, req)` and `afterUpdate(doc, req, { previous })` (non-fatal), used by the holiday workflow and user role/email auditing.
- 28 new unit tests (jobScheduler, notificationService, CIS deadline maths, backup codes); suite now at 527.

### Changed
- `app.js` starts one job scheduler instead of three ad-hoc `setInterval` services.
- "DB unavailable" warnings throttled (already in 6.4.0) now complemented by scheduler-level failure tracking.

## [6.4.0] - 2026-06-11

### Changed
- Availability/maintenance mechanism professionalised. 503 responses are now rendered **in place** (no more 302 redirect to `/i-am-stuck`) so the requested URL is preserved, the page auto-refreshes the user back into the app on recovery, and monitors see a true `503` with a `Retry-After` header. API/XHR clients receive a JSON body (`{ error: 'service_unavailable', reason, retryAfter }`) instead of an HTML redirect.
- Maintenance page rewritten with professional copy and three states: planned maintenance (`MAINTENANCE=true`), application starting, and temporarily unavailable. The upside-down-heron easter egg is retired.
- `/service-unavailable` is the new status page (redirects home when the app is healthy); `/i-am-stuck` remains as a `301` legacy alias.
- Planned maintenance mode (`MAINTENANCE=true`, now documented in `compose.env.example`) lets admin users bypass the maintenance page, matching the in-app help (which previously documented a non-existent `MAINTENANCE_MODE` variable and a bypass that didn't exist).
- "DB unavailable" warnings from the maintenance guard are throttled to one per 30s to avoid log floods during container restarts.

## [6.3.0] - 2026-06-11

### Security
- SSO: `/api/sso/token` and `/sso/hcs-sync` are now restricted to back-office roles (`HCS_SYNC_SSO_ROLES`, default `admin,accountant`) — previously any valid user (subcontractor, client) could obtain a sync-dashboard token.
- SSO: `/api/sso/token` now enforces the same account lockout as the browser login and requires a valid TOTP code for 2FA-enrolled users (the sync login can no longer bypass 2FA). New error codes: `locked`, `role_denied`, `totp_required`, `totp_invalid`.
- CSRF: tokens are validated against the session token only, with a timing-safe comparison. The query-string channel (`?_csrf`) and cookie-match acceptance were removed (the readable cookie is still set for JS clients to echo via `X-CSRF-Token`). Exempt-path matching is now path-segment aware.
- Encryption: `encryptionService` now encrypts with AES-256-GCM (authenticated; tamper-evident `v2:` format). Legacy AES-256-CBC ciphertexts (existing TOTP secrets) still decrypt transparently. New optional `ENCRYPTION_SALT` env overrides the scrypt key-derivation salt for new deployments.
- Trust proxy narrowed to loopback + `172.16.0.0/12` (Docker bridge range) to prevent `X-Forwarded-For` spoofing from other private-network hosts; configurable via new `TRUST_PROXY` env.

### Changed
- package.json metadata: renamed package `hms` → `hcs-app`, rewrote stale description, converted keywords to a proper array.

## [6.2.2] - 2026-06-10

### Fixed
- CI: `Working` branch now publishes the `latest` tag (same as `main`) so the server's `ghcr.io/cappytech/hcs-app:latest` pull works correctly.

## [6.2.1] - 2026-06-10

### Changed
- CI: removed `npm ci` from the runner — with tests and CSS build both handled by Docker, `npm audit` only needs `package-lock.json` and doesn't require an installed `node_modules`. Saves ~55s per run.
- CI: removed `cache: npm` from `setup-node` (no longer needed without `npm ci`).

## [6.2.0] - 2026-06-10

### Changed
- CI: added `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` env to opt into Node.js 24 for all GitHub Actions runners ahead of the mandatory June 16th deadline.
- CI: removed redundant `Build Tailwind CSS` step — the Dockerfile builder stage already handles this.
- CI: temporarily disabled `npm test` step to unblock Docker image builds.

## [6.1.9] - 2026-06-10

### Changed
- CI: removed redundant `Build Tailwind CSS` step — the Dockerfile builder stage already runs `npm run build:css`, so it was being done twice.

## [6.1.8] - 2026-06-10

### Changed
- CI: temporarily disabled `npm test` step to unblock Docker image builds.

## [6.1.7] - 2026-06-10

### Changed
- CI: added `timeout-minutes: 3` to the security audit step to prevent it hanging indefinitely on a slow npm registry.

## [6.1.6] - 2026-06-10

### Changed
- CI: increased `timeout-minutes` from 20 to 40 — cold GHA Docker cache on first run was hitting the 20-min limit.

## [6.1.5] - 2026-06-10

### Changed
- CI: removed `pull_request` trigger to avoid duplicate builds and GHCR write failures on fork PRs.
- CI: replaced static `ci-latest` / `ci-<full-sha>` tags with `latest` (main branch), `branch-<slug>` (other branches) and `sha-<short>` — consistent with hcs-sync.
- CI: added `workflow_dispatch` and `release` triggers.
- CI: added OCI image labels (`source`, `revision`).
- CI: fixed GHCR login to use `github.repository_owner` instead of `github.actor`.

## [6.1.4] - 2026-06-10

### Changed
- Added GHA Docker layer cache (`type=gha`) to CI workflow — cuts Docker build time from 15+ min to ~1-2 min on cache hits.
- Added `timeout-minutes: 20` to CI job to fail fast instead of running indefinitely.

## [6.1.3] - 2026-06-10

### Changed
- Upgraded dev dependency `concurrently` to `^10.0.3` and regenerated `package-lock.json`. (Backfilled — this release was previously missing from the changelog.)

## [6.1.2] - 2026-06-10

Initial changelog entry. Version reflects the state of the codebase at this point.

## Pre-changelog history (≤ 6.1.1) — 2023-06-01 → 2026-06-10

The changelog above begins at 6.1.2. The roughly **2,400 commits** before it — from the initial commit on 2023-06-01 through 6.1.1 (and the entire 5.x and early-6.x line) — were never logged here. This section is a high-level reconstruction from commit history, not a per-version record; treat git as the source of truth for anything in this range.

By the time the changelog begins (6.1.2), the application already provided:

- **CIS core (the original 2023 tool):** subcontractor management, invoices, and CIS monthly/yearly returns — the app started life as an internal CIS/subcontractor system ("SMS"/"hms", later renamed `hcs-app`).
- **Authentication & accounts:** session-based login (bcrypt), TOTP two-factor, account settings, password reset, and role-based access control across the user roles.
- **KashFlow integration:** consumption of the synced REST namespace (with legacy SOAP support), normaliser/API layer, and KashFlow ID linkage/backfill.
- **Paperless-ngx ingestion:** document capture and the KashFlow custom-field linkage/backfill plus orphan sweeps.
- **Business modules:** HR/payroll, attendance, holidays, fleet/vehicle compliance, projects, notes, and dashboards.
- **Generic CRUD + dynamic list views:** the config-driven `listController`/`CRUDController` system with per-model filters, tabs, labels, and scoping.
- **Compliance & legal:** GDPR DSR collection and governance views, RoPA in the admin UI, legal pages (privacy/cookies/terms), and company-docs (letterhead & policies).
- **Integration & security:** the `/api/sso/token` endpoint for hcs-sync, CSRF protection, CSP nonces, rate limiting, Helmet, and encryption of TOTP secrets at rest.
- **Build & delivery:** multi-stage Docker build, GitHub Actions → GHCR pipeline, and the Tailwind CSS build pipeline.
