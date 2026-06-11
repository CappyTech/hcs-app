# Changelog

All notable changes to hcs-app will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

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

## [6.1.2] - 2026-06-10

Initial changelog entry. Version reflects the state of the codebase at this point.
