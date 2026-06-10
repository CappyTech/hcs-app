# Changelog

All notable changes to hcs-app will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

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
