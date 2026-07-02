# HCS App

**Internal business platform for Heron Constructive Solutions LTD** — a custom, in-house ERP for a UK construction business. It consolidates CIS/HMRC compliance, payroll & RTI filing, HR, attendance, fleet, supplier-invoice automation, and finance dashboards into one role-aware portal.

Provider-agnostic on the accounting side: it reads synced accounting data from MongoDB rather than coupling directly to any one accounting provider.

> For deeper architecture, security, and module notes see [AGENTS.md](AGENTS.md). For the feature-by-feature design rationale see the walkthrough below.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [App Structure](#app-structure)
- [Application Lifecycle (app.js)](#application-lifecycle-appjs)
- [Feature Walkthrough](#feature-walkthrough)
- [Development Deployment](#development-deployment)
- [Production Deployment](#production-deployment)
- [Testing](#testing)
- [Development Rules](#development-rules)
- [License](#license)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 20+ (built & run on Node 24 in Docker) |
| Web framework | Express 4 |
| Views | EJS + `express-ejs-layouts`, styled with Tailwind CSS 3 (built locally, not CDN) |
| Database | MongoDB via Mongoose 8 — three logical databases: `INTERNAL`, `REST`, `PAPERLESS` |
| Sessions | `express-session` + `connect-mongo` (Mongo-backed store) |
| Real-time | Socket.IO |
| Auth & security | bcrypt, JWT (`jsonwebtoken`), TOTP (`otplib` + `qrcode`), Helmet, CSRF, `express-rate-limit`, `xss`, `sanitize-filename`, Have-I-Been-Pwned breach checks |
| Integrations | KashFlow (accounting), Paperless-ngx (OCR document ingestion), HMRC RTI (FPS/EPS), People's Pension, Twilio (SMS), Nodemailer (email), Cloudflare Turnstile |
| Tunnelling | `tunnel-ssh` (optional SSH tunnels to MongoDB / Paperless) |
| Logging | Winston |
| Uploads | Multer (type + size restricted) |
| Tooling | Tailwind CLI, PostCSS, Autoprefixer, Nodemon, Concurrently |
| Tests | Node built-in test runner (unit) + Playwright (e2e) |
| Delivery | Docker (multi-stage) · Caddy (auto-HTTPS reverse proxy) · Tailscale (private networking) · GitHub Container Registry (CI images) |

Shared Mongoose schemas are published separately via [`@cappytech/hcs-schemas`](https://github.com/CappyTech/hcs-schemas).

---

## App Structure

```
app.js                  # Entry point — two-phase boot, middleware chain, route mounting
Dockerfile              # Multi-stage build (CSS builder → production image)
docker-compose.yml      # Production stack (Tailscale + app + Caddy)
docker-compose.local.yml# Local stack (Tailscale + app + MongoDB)
Caddyfile               # Reverse-proxy / TLS config
compose.env.example     # Template for runtime environment variables
docker-entrypoint.sh    # Container entrypoint

assets/                 # Source Tailwind CSS
public/                 # Built CSS, JS, images, favicon, robots.txt, manifest
config/                 # Runtime app-config.json (written by the setup wizard)

mongoose/
  routes/               # Express route modules (one per feature — all mounted in app.js)
  controllers/          # Request handlers: CRUD, list, CIS, payroll, paperless, fleet…
  config/               # rolePermissionsConfig (RBAC), CRUD/list configs, dashboard tiles, cisMappings
  models/               # Mongoose schemas, split into REST/ · INTERNAL/ · PAPERLESS/
  services/             # DB connections, sessions, session activity, websockets, job registry
  views/tailwindcss/    # EJS templates + partials (the ONLY active view tree)

services/               # Cross-cutting services:
                        #   authService, csrfService, securityService, rateLimiterService,
                        #   encryptionService, loggerService, emailService, smsService,
                        #   configService, maintenanceService, hmrcRtiService, taxService,
                        #   peoplesPensionService, kashflow*Service, paperless*Service, …

kashflowAPI/            # KashFlow normalizer / API layer
docs/                   # API docs, CURL examples, architecture & timeline notes
scripts/                # Utilities (tailwind safelist generation, migrations, test runner)
tests/                  # Unit tests
e2e/                    # Playwright end-to-end tests
```

---

## Application Lifecycle (app.js)

[`app.js`](app.js) is a wiring diagram, not business logic. It boots in two phases so the app is never hard-down:

1. **Phase 1 — listen immediately.** Starts the HTTP server with only static assets, `/healthz`, the CSP-report collector, and a request blocklist. An empty `appRouter` is mounted; everything else falls through to `maintenanceService`, which returns a friendly `503 + Retry-After` while the database comes up. If the app isn't configured yet, it instead mounts the **first-run setup wizard** at `/setup`.
2. **Phase 2 — connect & mount.** After `mdb.connect()` succeeds, it runs one-time migrations, bootstraps the first admin (from wizard credentials), loads CIS nominal-code mappings, then mounts the full middleware stack (sessions, CSRF, security headers, RBAC auth, rate limiting, logging) and all feature routes. Finally it starts Socket.IO and the background-job scheduler.

If MongoDB never connects, the process stays alive serving maintenance pages rather than crash-looping.

---

## Feature Walkthrough

Each feature is described from three angles: **Dev** (how it's built), **User** (what staff experience), and **Business Owner** (why it matters commercially). Access to every feature is gated by the RBAC config in [`rolePermissionsConfig.js`](mongoose/config/rolePermissionsConfig.js) (roles: `admin · accountant · employee · subcontractor · client · hmrc · none`).

### 1 — Two-Phase Startup & Maintenance Page
- **Dev.** Server listens before the DB is ready; all traffic falls through to `maintenanceService` (503 + Retry-After) until Mongo connects. Process-level `unhandledRejection`/`uncaughtException` handlers log instead of crashing.
- **User.** During restarts you see a clean auto-retrying "service starting" page, never a raw error.
- **Business Owner.** Graceful degradation — deploys look seamless and transient DB blips don't trigger a flood of "it's broken" reports.

### 2 — First-Run Setup Wizard
- **Dev.** When required config is missing, only `/setup` is mounted (throwaway in-memory session). On completion the process restarts and the first admin is created from `_bootstrapAdmin`, then those credentials are wiped.
- **User.** A non-technical person can stand the app up through a browser form.
- **Business Owner.** Deployment/migration no longer needs a developer hand-editing config files.

### 3 — Configuration & Connection Settings
- **Dev.** `configService` layers `config/app-config.json` under OS/Docker env vars (env wins). Admin pages at `/admin/connections/*` manage KashFlow, SMTP, Paperless, SMS, each with a live "Test" endpoint.
- **User.** Admins can re-point email / API keys from a settings page and verify them — no redeploy.
- **Business Owner.** Operational independence: rotating a credential or swapping a mail provider is a 2-minute admin task.

### 4 — Authentication, Sessions & Account Self-Service
- **Dev.** Register / login / logout, email verification, and a multi-channel password reset (email link, SMS OTP, TOTP). Mongo-backed sessions; `/user/account` lets users change password, manage TOTP, regenerate backup codes, and log out individual or all other sessions.
- **User.** Modern self-service account management, including seeing and killing active sessions.
- **Business Owner.** Fewer password-reset requests and reduced account-takeover risk on a system holding financial data.

### 5 — Two-Factor Authentication
- **Dev.** `/user/2fa` runs outside the normal auth guard (a pending user only holds `userPending2FA`). TOTP + backup codes; specific roles can be force-enrolled via `REQUIRE_2FA_ROLES`.
- **User.** Optional/enforced authenticator-app login with backup codes.
- **Business Owner.** A real security control for payroll, CIS, and supplier banking data.

### 6 — Role-Based Access Control (RBAC)
- **Dev.** Single source of truth maps roles → departments (nav) and → per-model CRUD with an `:own` row-level scope, plus additive per-user `customPermissions`. Enforced by `ensureAuthenticated` + `ensureRouteAccess`, and re-exposed to templates (`canDept`/`canModel`).
- **User.** You only see the parts of the system relevant to your job.
- **Business Owner.** Enforced least-privilege / separation of duties, and a safe way to give accountants, HMRC, and clients scoped access to just their slice.

### 7 — Generic CRUD & List Engines
- **Dev.** `CRUDRoutes` and `listRoutes` auto-generate routes by reflecting over exported `create/read/update/delete/listX` handlers, merging middleware and labels from config. A UUID `router.param` guard prevents the generic `/:uuid` routes from shadowing specific ones.
- **User.** Every entity gets consistent create/read/update/delete/list screens.
- **Business Owner.** Adding a new data type is config-driven and cheap — keeps build costs down and the UI predictable.

### 8 — CIS (Construction Industry Scheme)
- **Dev.** Monthly CIS dashboard and yearly/monthly returns for all or a single subcontractor; nominal-code mappings loaded from the DB at startup. Subcontractors get scoped read access to their own returns.
- **User.** Finance see deductions per subcontractor per tax month; subcontractors view their own statements; HMRC role reviews verification data.
- **Business Owner.** Automates a legal HMRC obligation, cutting manual spreadsheet work and penalty risk.

### 9 — Attendance & Approval Workflow
- **Dev.** Daily/weekly views (scoped by role), self-service submission, admin/accountant inline editing, and an approve/reject/bulk-approve workflow; also covers job assignments and vehicle deployments.
- **User.** Workers submit hours; managers review a weekly grid and approve in bulk.
- **Business Owner.** An auditable timesheet system feeding payroll and CIS, tying labour to jobs and vehicles.

### 10 — Payroll & HMRC RTI
- **Dev.** Full payroll engine: create runs, calculate/recalculate, override entries, lock/unlock, post a KashFlow journal, submit **FPS/EPS to HMRC**, export People's Pension CSV, manage per-year tax-rate tables and per-employee settings.
- **User.** Run payroll, review/override, lock, file to HMRC, export the pension file — all in-app.
- **Business Owner.** Replaces external payroll software and consolidates statutory PAYE/NIC filing and pension submissions. High-value, high-stakes — worth careful testing.

### 11 — Paperless OCR / Purchase-Invoice Capture
- **Dev.** Ingests OCR'd documents from Paperless-ngx, builds purchase drafts, matches suppliers, and pushes purchases into KashFlow; includes drift-repair/orphan-cleanup maintenance and a stricter rate limiter on the ingest trigger.
- **User.** A scanned invoice becomes a checked KashFlow purchase with no manual re-keying.
- **Business Owner.** Supplier-invoice automation — far less data entry, fewer transcription errors, with a linked document trail.

### 12 — Overviews / Executive Dashboards
- **Dev.** Roll-up read dashboards for fleet, HR, finance, projects, subcontractors, payroll, documents, and policies, with actions like project financial checks and mark-complete.
- **User.** Managers get area roll-ups in one screen.
- **Business Owner.** The cockpit for decision-making across the business.

### 13 — Subcontractor & Submission Administration
- **Dev.** Admin tools to link logins to subcontractor records, change supplier assignments, and reassign receipts/purchases between submissions.
- **User.** Admin connects a login to the right subcontractor or fixes a misfiled receipt.
- **Business Owner.** Keeps CIS/finance data correctly attributed for accurate statements and HMRC returns.

### 14 — File / Document Handling
- **Dev.** Multer uploads with a strict allow-list (jpg/png/pdf/doc/docx, 5 MB), admin-only, gated by `ensureHandlesDocuments`, with explicit CSRF validation.
- **User.** Attach and retrieve supporting documents on any record.
- **Business Owner.** Centralised, entity-linked document storage with upload restrictions that limit abuse.

### 15 — Holiday Block, GDPR, Company Docs & Legal
- **Dev.** A `checkHoliday` middleware can show a dismissible block page; GDPR routes let users file/withdraw data-subject requests and admins review them; admin company-docs CRUD manages policies, letterhead, and printable views; public legal pages serve cookie/privacy/terms.
- **User.** Staff raise GDPR requests in-app; admins maintain policies and produce letterheaded documents.
- **Business Owner.** Direct GDPR/ICO compliance tooling and published legal pages — reduces legal exposure.

### 16 — Admin Operations: Jobs, Security Events, Maintenance, Logs
- **Dev.** Deleted-item recovery, a background-job dashboard with manual triggers, a security-events audit trail, maintenance-mode toggles, searchable app logs, and dedicated KashFlow/Paperless API logs (plus an admin `/__debug/headers`).
- **User.** Admins can replay jobs, review security events, recover deleted records, and schedule downtime.
- **Business Owner.** Operational visibility and recoverability without a developer in the loop.

### 17 — SSO Bridge to hcs-sync
- **Dev.** Issues signed JWTs for machine-to-machine auth with the companion `hcs-sync` service (rate-limited), plus a browser-redirect handoff fallback restricted to an allowlist of return hosts.
- **User.** Move between the main app and the sync tool without logging in twice.
- **Business Owner.** One shared identity source across internal systems — simpler admin, single revocation point.

### 18 — Cross-Cutting Security Layer
- **Dev.** CSRF, Helmet/CSP (with a `/csp-report` collector), flash messaging, request logging, rate limiting, scanner blocklist, careful `trust proxy` config (loopback + Docker bridge only), `x-powered-by` disabled, and aggressive no-cache headers.
- **User.** Mostly invisible — the app resists abuse and never serves stale data.
- **Business Owner.** Defence-in-depth protecting financial and personal data, lowering breach and regulatory risk.

---

## Development Deployment

Requires **Node.js 20+** and a reachable MongoDB.

### Option A — Local Node (fastest inner loop)

```bash
cp .env.example .env       # configure environment variables
npm install
npm run dev                # runs the server (nodemon) + Tailwind CSS watch concurrently
```

The app listens on `PORT` (default `3000` locally). If `SESSION_SECRET`, `ENCRYPTION_KEY`, and a Mongo connection aren't configured, it boots into the setup wizard at `/setup`.

### Option B — Local Docker stack (includes MongoDB)

```bash
docker compose -f docker-compose.local.yml up -d --build
```

This brings up Tailscale, the app, and a `mongo:8` container. The app is reachable at **http://localhost:3000**. `ENABLE_HSTS=false` and `COOKIE_SECURE=false` are set so plain HTTP works. On first run, complete the wizard at `/setup`; it writes `config/app-config.json` (mounted as a volume), then restart the container to launch the full app.

---

## Production Deployment

Production runs the published CI image from GitHub Container Registry behind Caddy, with all app traffic routed through Tailscale.

```bash
cp compose.env.example compose.env   # set APP_IMAGE_TAG, secrets, domain, etc.
docker network create hcs-net        # external network (one-time)
docker compose up -d
```

Key details ([`docker-compose.yml`](docker-compose.yml)):

- **Image:** `ghcr.io/cappytech/hcs-app:${APP_IMAGE_TAG:-ci-latest}` with `pull_policy: always`.
- **Networking:** the app shares the **Tailscale** container's network namespace, so Caddy proxies to `tailscale:${PORT}` (not `hcs-app:${PORT}`).
- **TLS:** **Caddy** terminates HTTPS automatically — edit the [`Caddyfile`](Caddyfile) for your domain.
- **Health:** Docker health check hits `GET /healthz` (loopback-only; reports readiness of all three DB connections).
- **Persistence:** `./uploads` and `./logs` are bind-mounted; Caddy and Tailscale keep their own named volumes.
- **Build identity:** pass `--build-arg GIT_COMMIT=$(git rev-parse --short HEAD)` so the short SHA appears in the app footer.

The container is built from a multi-stage [`Dockerfile`](Dockerfile): stage 1 compiles Tailwind CSS, stage 2 produces a slim `node:24-alpine` production image (`npm ci --omit=dev`, `dumb-init` as PID 1, `NODE_ENV=production`, listening on port `5000`).

---

## Testing

```bash
npm test                # unit tests (Node built-in test runner)
npx playwright test     # e2e tests (run only when e2e/ files changed)
```

---

## Development Rules

- **Terminal:** use Git Bash.
- **Views:** only edit `mongoose/views/tailwindcss/` — never the legacy `mongoose/views/mongoose/` tree.
- **Include chain:** trace any new file back to `app.js` to confirm it's actually loaded.
- **CSS:** Tailwind is built locally — after changing classes run `npm run gen:tailwind-safelist` then `npm run build:css` if dynamic classes go missing.
- **Tests:** run `npm test` before committing; run `npx playwright test` if `e2e/` changed.
- **Clean tree:** ensure `git status` is clean before finishing.

See [`docs/Project-Timeline.md`](docs/Project-Timeline.md) for a phase-based work summary and [`docs/IMPROVEMENTS-BACKLOG.md`](docs/IMPROVEMENTS-BACKLOG.md) for the outstanding backlog.

---

## License

**All rights reserved.** © Heron Constructive Solutions LTD.

This is proprietary internal software. It is not open source and may not be copied, distributed, or used outside Heron Constructive Solutions LTD without express written permission.
</content>
</invoke>
