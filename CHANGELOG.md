# Changelog

All notable changes to hcs-app will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [6.8.9] - 2026-07-02

### Changed
- **Per-model read views for customer, invoice, quote, purchase, project and employee** — continuing the v6.8.0 migration off the generic `partials/form-read.ejs` (previously done for user, assignment, contract). Each model now has a compact, curated detail view at `mongoose/views/tailwindcss/<model>/read.ejs`, wired via `config.readView` in `listControllerConfig.js`:
  - **invoice / quote / purchase**: number + status header with linked customer/supplier (CIS % badge on purchases), "Open in KashFlow" deep link, amount and date tile grids, dedicated Items table (Description/Qty/Rate/VAT/Net with project & nominal context) and Payments table — replacing the raw schema dump.
  - **customer**: balance and account-history tiles, contact details, related Invoices / Quotes / Projects tables (moved from form-read).
  - **project**: dates + financial tiles (actual/target/WIP), customer link, contracts table, documents card.
  - **employee**: status/type/IR35 chips, contact line, rate tiles, resolved **Manager** and **Linked Supplier** links (new lookups in the employee `readLocals` — the list-only `fieldTransforms` never applied to detail views), vehicles/holiday tables, documents card. Payroll settings are deliberately not rendered on this view.
  - **New shared partials**: `partials/_meta-tile.ejs` (stat tile), `partials/_documents-card.ejs` (extracted from form-read, reused by form-read itself), `partials/read/_party-card.ejs`, `partials/read/_lineitems-card.ejs`, `partials/read/_payments-card.ejs`. Status pills reuse `partials/_status-badge.ejs`.
  - **form-read.ejs slimmed by ~340 lines**: the migrated models' `<% if (basePath === '…') %>` related-record blocks were removed (supplier CIS calendars/purchases and vehicle logs remain — those models still use the generic view); the documents block now includes the shared partial.

### Added
- `tests/readViews.test.js` — EJS render smoke-tests for all six new views, each rendered with full and minimal locals to catch template errors and unguarded references (also asserts payroll data never leaks into the employee view). Suite: 658 tests passing.

## [6.8.8] - 2026-07-02

### Fixed
- **KashFlow posting is now double-submit safe** (the roadmap's "Idempotent KashFlow posting" item). Both posting paths used check-then-act: read a "already posted?" flag, then spend 20–30s on the KashFlow HTTP call before persisting the result — so a double-click, second tab, or retried request could pass the check twice and create **duplicate purchases/journals** in the ledger.
  - **Payroll journal** (`payrollJournalService.postPayrollJournal`): the run is now claimed atomically via `findOneAndUpdate` (filter: locked + no `kashflowJournalRef` + no live claim) before anything is sent; concurrent posters get a clear "already in progress" / "already posted (ref …)" error. New `payrollRun.journalPostingAt` (claim timestamp, stale after 5 min so a crashed process never wedges the run) and `journalLastError` fields. On ambiguous failures (timeout, connection drop, 5xx) the error now points at the run's deterministic KashFlow reference (`PAY-<uuid8>`) so the journal can be searched for in KashFlow before retrying.
  - **AP capture send** (`paperlessController.sendDraftToKashflow`): the per-document idempotency pre-check is replaced by an atomic claim in the new `mongoose/services/paperless/kashflowSendClaimService.js` (`OcrDocument.kfSendLockedAt`, same 5-minute stale-takeover). The claim is released on every exit path (duplicate-block redirect, success render, error render); a successful send remains blocked afterwards by the existing already-linked condition, and a failed send does not permanently block a retry.

### Added
- `tests/kashflowSendClaimService.test.js` and `postPayrollJournal` tests in `tests/payrollJournalService.test.js` — claim-filter shapes (already-linked exclusion, stale takeover), win/lose/diagnose paths, success persistence clearing the claim, ambiguous-vs-definite failure handling, and release-never-throws. `postPayrollJournal` is exercised end-to-end against mocked models with a patched axios and the preset-token KashFlow auth path. Suite: 646 tests passing.

## [6.8.7] - 2026-07-02

### Changed
- **Payroll tax rates now seed automatically at startup** (`mongoose/services/payrollTaxRatesSeedService.js`, wired into the Phase 2 migrations in `app.js`), replacing the manual `scripts/seed-payroll-tax-rates.js` deployment step that had let the wrong 13.8% employer NI rate sit in the live database. Semantics:
  - **Insert-only for whole years** (`$setOnInsert` upsert): rates an admin has edited in Settings → Payroll → Tax Rates are never overwritten by a restart or deploy.
  - **Exact-value corrections**: values written by pre-6.8.6 seeds (13.8% employer NI, 2024/25 student-loan thresholds, stale LEL, 2026/27 estimates) are fixed only when the stored value still equals the known-bad one, so admin-corrected documents are left alone. Also backfills the new `niEmployeeReducedRate` field on pre-existing documents.
  - This removes the "re-run the seed script on the server" follow-up from 6.8.6 — deploying this version corrects the live rate table on boot. Recalculating unsubmitted runs (and reviewing already-submitted FPS) is still required.
- `scripts/seed-payroll-tax-rates.js` is now a thin **force-reset** utility over the same shared `DEFAULT_RATES` data (single source of truth), kept only for recovering a corrupted rate table; it warns that it overwrites admin edits.

### Added
- `tests/payrollTaxRatesSeedService.test.js` — guards the shipped statutory data (15% employer NI, published student-loan thresholds, 1.85% category B) and the seeding semantics (insert-only writes, exact-value correction filters, reduced-rate backfill).

## [6.8.6] - 2026-07-02

### Fixed
- **Statutory payroll corrections** (verified against HMRC "Rates and thresholds for employers" 2025/26 and 2026/27) — the roadmap's "correctness floor" pass over the PAYE/NI/CIS/RTI engines:
  - **Employer NI rate corrected from 13.8% to 15%** in `scripts/seed-payroll-tax-rates.js` for both 2025/26 and 2026/27. The rate rose to 15% at Autumn Budget 2024 (effective 6 April 2025); the seed only reflected the Secondary Threshold drop to £5,000. Employer NI was being **under-calculated by 1.2 percentage points**. ⚠️ Re-run the seed script on the server and recalculate any unsubmitted payroll runs; runs already submitted via FPS under-reported employer NI and may need a corrective submission.
  - **Student loan thresholds corrected**: 2025/26 Plan 1 was seeded with the 2024/25 value (£24,990 → **£26,065**) and Plan 4 likewise (£31,395 → **£32,745**) — both were over-deducting. 2026/27 estimates replaced with published values (Plan 1 £26,900, Plan 2 £29,385, Plan 4 £33,795). 2025/26 LEL corrected £6,396 → £6,500.
  - **Student/postgrad loan deductions now round down to the whole pound** (HMRC SL3 rule) instead of truncating to pence (`payrollCalculationService.calculateStudentLoan`, with float-noise guard so e.g. an exact £75.00 result can't floor to £74).
  - **NI category B (married women's reduced rate) corrected from 5.85% to 1.85%** — the rate dropped in March 2024 alongside the main-rate cut. Now DB-driven via new `payrollTaxRates.niEmployeeReducedRate` field (default 0.0185), editable in Settings → Payroll → Tax Rates.
  - **PAYE 50% regulatory "overriding limit" implemented** (`calculatePAYETax`, both cumulative and week1/month1 bases): tax deducted in a period is capped at 50% of the pay it is deducted from (applies to all codes since April 2015; K codes could previously deduct without limit).
  - **Employer NI relief categories implemented** (`calculateEmployerNI`): categories H (apprentice under 25), M/Z (under 21) and V (veteran) now pay 0% employer NI up to the UST/AUST/VUST (aligned with the UEL) and the standard rate only above it; category X pays none. The category letter is now passed through from the employee record.
  - **NI rounding now follows the CWG2 exact-percentage method** — nearest penny with an exact half penny rounded down — replacing plain truncation for employee and employer NI.

### Added
- **HMRC reference-case unit tests** for the statutory engines (`tests/payrollCalculationService.test.js`, `tests/cisService.test.js`, `tests/hmrcRtiService.test.js`): exact-value PAYE cases (cumulative and week1/month1, K-code overriding limit), NI cases for categories A/B/C/H/J/M/V/X/Z including the half-penny rounding rule, whole-pound student-loan cases, CIS verification-number regex and supplier-predicate cases, and real `buildFPSForRun`/`buildEPS`/`buildFraudHeaders` tests running against mocked models with encrypted fixtures (decrypted NINO, money formatting, week/month numbers, Wk1Mth1 indicator, conditional student-loan elements, XML escaping, draft-run guard, EPS aggregation). Suite: 615 tests passing.

## [6.8.5] - 2026-06-26

### Fixed
- **"Print / Save PDF" button on the policy view did nothing** (`mongoose/views/tailwindcss/company-docs/policy-print.ejs`). The button used an inline `onclick="window.print()"`, which the nonce-based Content-Security-Policy blocks (inline event-handler attributes aren't covered by script nonces). Replaced with a nonced `<script>` that attaches the click handler, matching the existing `cis/partials/_printButton.ejs` pattern.

## [6.8.4] - 2026-06-26

### Added
- **Database audit trail (`INTERNAL.auditLog`).** All write operations on INTERNAL collections — and single-record reads of sensitive models — are now recorded to an append-only audit log with actor attribution.
  - **New collection/model** `mongoose/models/mongoose/INTERNAL/auditLog.js`: `{ collectionName, op (create/update/delete/read), docId, docUuid, actor + actorName/actorEmail snapshot, ip/method/route, before, after, changes, at }`, with indexes for per-document history and recent-first scans. Optional retention via `AUDIT_TTL_DAYS` (a TTL index; unset/0 keeps the trail indefinitely).
  - **Actor context** `mongoose/services/auditContextService.js`: `AsyncLocalStorage` middleware (mounted after auth in `app.js`) binds the acting user + request metadata to the async context so writes are attributed without threading `req` through every call. Operations outside a request (cron/jobs) are recorded as "System".
  - **Audit plugin** `mongoose/services/auditPlugin.js`: applied to every INTERNAL schema at the single registration chokepoint in `mongooseDatabaseService.createNamespace`. Hooks `save`/`insertMany` (create/update) and query `findOneAndUpdate`/`updateOne`/`updateMany`/`findOneAndDelete`/`deleteOne`/`deleteMany` (with before/after snapshots and a field-level diff). Snapshots are sanitised — binary blobs dropped, long strings truncated — so e.g. the letterhead logo buffer is never copied into the log. Audit writes never throw, so a logging failure can't break the underlying operation.
  - **Sensitive reads**: single-record reads (`findOne`/`findById`) of nominated models are logged for GDPR subject-access accountability. Default `employee,payrollEntry`, configurable via `AUDIT_SENSITIVE_MODELS`. List reads are intentionally not logged.
  - **Viewer** at `/audit` (admin-only): `auditController` + `mongoose/views/tailwindcss/audit/index.ejs` — filter by collection / operation / actor or record id, expandable change detail, pagination. Registered in `rolePermissionsConfig`, with an "Audit Log" tile on the Admin dashboard (`dashboardTilesConfig.js`).
  - **Background-job attribution**: the central job scheduler (`jobSchedulerService.execute`) now runs each job inside an audit context, so writes from cron tasks (review reminders, sync, cleanup) are attributed to `System (<job name>)` rather than a blank actor. Any other context-less write also records as "System" (`auditPlugin.record`).
  - **Exclusions**: the audit log itself and high-frequency infrastructure writes (`session`) are excluded by default (`AUDIT_EXCLUDE_MODELS`) to prevent recursion and log flooding.
  - **Note:** MongoDB's built-in auditing is Enterprise/Atlas only (this deployment runs Community `mongo:8`) and cannot attribute actions to app users, so the trail is implemented at the application layer.

## [6.8.3] - 2026-06-26

### Added
- **Per-policy review cadence rules** (`mongoose/models/mongoose/INTERNAL/policyDocument.js`, `policy-form.ejs`, `companyDocsController`). Two new per-policy fields let each policy define when it is considered out of date: `reviewIntervalMonths` (default 12; `0` = never expires) and `reviewWarningDays` (default 30 — how far ahead it is flagged "due soon"). On create/edit, if no explicit **Next review date** is given, `reviewDate` is derived as *now + interval* (`deriveReviewDate`/`parseNonNegInt` helpers), so the existing `policyReviewReminderService` (which emails admins ahead of `reviewDate`) keeps working unchanged. The form gained "Review every (months)" and "Flag due soon (days before)" inputs, and the date field is now an optional override.
- **Group-by control on the policy list** (`policy-list.ejs`, `getPolicyList`). A `?groupBy=` toggle switches between **Category** (default), **Employee**, **Published** (Published / Draft), and **Review status** (Out of date / Due soon / Up to date / No review date). Review state is resolved per policy from its own cadence rules (`resolveReview`): *out of date* when the effective review date has passed, *due soon* within that policy's warning window, with coloured group headers and review badges.
- **Employee-specific documents** (`policyDocument.js`, `policy-form.ejs`, `policy-list.ejs`, `policy-print.ejs`, `companyDocsController`). Policies can now be assigned to an individual employee via a new optional `employee` ref (e.g. contracts, onboarding packs); unassigned policies remain company-wide. The create/edit form gained an "Assign to employee" dropdown, the list shows an employee chip and can **group by employee** (Company-wide first, then each employee A–Z), and the printed document shows a "Prepared for: …" line. The reminder list/email populate the employee for display.
- **New policy categories** (`policyDocument.js`). Added **Employee Handbook**, **Employee Contract**, and **Onboarding** to the category enum. The category list is now a single exported `POLICY_CATEGORIES` constant consumed by the model enum, the form select, and the list's group ordering (no more duplicated hard-coded lists).

### Fixed
- **Policy review reminder email now honours each policy's warning window** (`mongoose/services/policyReviewReminderService.js`). Previously every policy was flagged using one global 30-day horizon; the service now fetches all policies with a review date and includes each one based on its own `reviewWarningDays` (falling back to the 30-day default), matching the list's "due soon" logic.

### Changed
- **Policy print/letterhead styling** (`mongoose/views/tailwindcss/company-docs/policy-print.ejs`):
  - **Header colour corrected to the brand green.** The company name, header underline, and `h1` body headings were hard-coded to off-palette `#064e3b` (emerald-900); changed to the defined brand colour `#047857` (`brand.DEFAULT` in `tailwind.config.js`).
  - **Footer simplified.** Dropped the "Registered in England & Wales" wording and the `•` bullet separators. The fallback footer now renders the company name, "Company No. …", and "VAT No. …" as spaced segments (new `.lh-footer-meta` flex container).
- **Policy list redesigned and grouped by category** (`mongoose/views/tailwindcss/company-docs/policy-list.ejs`, `companyDocsController.getPolicyList`):
  - Policies are now **grouped into per-category cards** (ordered HR → Health & Safety → GDPR → Finance → Operations → General, then any others alphabetically), each with a category header and policy count, so the list scales as policies grow. The redundant per-row Category column was removed. `getPolicyList` builds the `groups` array; `policies` is still passed for the empty-state check.
  - The **policy title is now a link** to the view (`/company-docs/policies/:uuid/print`).
  - The row's **"Print" action is now "View"** (`bi-eye`, opening the same view page) — the redundant print-from-list action is gone; printing is done from the View page's existing "Print / Save PDF" button.

## [6.8.2] - 2026-06-26

### Fixed
- **Letterhead logo did not persist across redeploys** (`/company-docs/letterhead`). The uploaded logo was written to the container filesystem (`public/images/letterhead-logo.*`) and served from `/resources/images/...`, but `public/` is baked into the image at build time and is not a mounted volume, so every `docker compose pull && up -d` reset the filesystem and deleted the file — leaving `letterhead.logoPath` pointing at a missing image. The logo bytes are now stored in MongoDB on the singleton letterhead document (`logoData` Buffer + `logoMime`) and served via a new admin-only route `GET /company-docs/letterhead/logo` (with a cache-busting query string set on each upload), so the logo persists with the database. Upload switched from `multer.diskStorage` to `multer.memoryStorage`; render queries exclude the `logoData` buffer via `.select('-logoData')`. Files: `mongoose/models/mongoose/INTERNAL/letterhead.js`, `mongoose/controllers/companyDocsController.js`, `mongoose/routes/companyDocsRoutes.js`.

## [6.8.1] - 2026-06-26

### Added
- **Holiday Overview page (`/overview/holiday`).** New admin overview hub joining the existing `/overview/*` family, surfacing current-period entitlement balances (with low-balance flags), pending requests awaiting approval, recent decisions, and upcoming government + company holidays, linking through to `/employeeHolidays`, `/holidayRequests`, `/holidays` and `/holidayCustoms`. New `holidayOverviewService` (`mongoose/services/holidayOverviewService.js`), `overviewController.getHolidayOverview`, route in `overviewRoutes.js`, and view `mongoose/views/tailwindcss/overview/holiday.ejs`. Also added to the home-page Overviews grid (`index.ejs`).

### Fixed
- **Holiday and Fleet dashboard tiles returned "Page Not Found".** The `HolidayManagement` tile linked to `/holiday` and the `FleetManagement` tile to `/fleet`, neither of which had a route. Both tiles now point at their overview pages (`/overview/holiday`, `/overview/fleet`) and were retitled to "Holiday Overview" / "Fleet Overview" to match the `PayrollOverview` convention. Removed the dead `/holiday` and `/fleet` entries from `rolePermissionsConfig` route access (the `/overview/*` routes are guarded by `ensureRole('admin')` in the route handler, like their siblings).

## [6.8.0] - 2026-06-26

### Changed
- **Overhauled the generic read/detail view** (`mongoose/views/tailwindcss/partials/form-read.ejs`, `partials/_formField.ejs`):
  - **Field layout** replaced individual grey pill-per-field boxes with a horizontal key/value row pattern (label flush-left at fixed width, value to the right, `border-b` dividers) matching the UI guidelines "Detail Key/Value Rows" standard.
  - **Main details panel** switched from `bg-gray-50 p-6` to a clean `bg-white border border-gray-200 rounded-2xl overflow-hidden` card so rows sit flush inside it.
  - **Grouped fieldsets** now render a `bg-gray-50` legend strip spanning the full card width rather than a floating inner border box.
  - **Sub-section cards** (Documents, CIS calendars, Purchases, vehicle logs) switched from the gradient-top-bar pattern to the `border border-gray-200 rounded-2xl shadow-sm` standard card with a `border-b` header row.
  - **Section headings** standardised to `font-semibold text-sm uppercase tracking-wide text-gray-500`.
  - **All tables** updated: `th` to `font-semibold uppercase tracking-wide`; `py-2` → `py-3`; `tbody tr` gets `hover:bg-gray-50 transition`; `divide-y divide-gray-100` on tbody; empty cells now render `—`.
  - **Update button** icon changed from `bi-arrow-clockwise` to `bi-pencil`.
  - **Vehicle quick-action buttons** replaced raw HTML emoji with Bootstrap Icons (`bi-fuel-pump`, `bi-car-front`, `bi-wrench-adjustable`); "Log Service" colour changed from `bg-purple-600` to `bg-violet-600`.
  - **Action button colour logic** refactored from repeated inline ternary chains to a `_btnColor()` lookup helper.
  - Back link, page title, and link colours corrected to match UI guidelines (`green-700`, `font-bold`).

### Added
- **Cross-model related-record panels** on all generic detail pages (`form-read.ejs`, `listControllerConfig.js`):
  - **Customer detail** now shows three linked tables below the main fields — *Invoices* (number→`/invoice/read/`, status badge, gross, paid), *Quotes* (number→`/quote/read/`, status badge, gross), and *Projects* (ref→`/project/read/`, status badge, start/end). Injected via new `readLocals` querying `invoice.CustomerId`, `quote.CustomerId`, `project.CustomerCode`.
  - **Invoice detail** now shows a linked *Customer* card (name→`/customer/read/`). Injected via `readLocals` resolving `CustomerId` → customer record.
  - **Quote detail** now shows a linked *Customer* card (name→`/customer/read/`). Same pattern as invoice.
  - **Purchase detail** now shows a linked *Supplier* card (name→`/supplier/read/`, code, CIS badge if `WithholdingTaxRate` is set). Injected via `readLocals` resolving `SupplierId` → supplier record. Previously `SupplierId` was in `hideFields` and completely absent from the detail view.
  - **Project detail** now shows a linked *Customer* card (name→`/customer/read/`) and a *Contracts* table (title→`/contract/read/`, status badge, start/end). Injected via `readLocals` resolving `CustomerCode` → customer and querying `contract.projectId`.
  - **Employee detail** now shows *Vehicles* (reg→`/vehicle/read/`, make/model, status badge), *Holiday Entitlements* (period→`/employeeHoliday/read/`, entitlement/accrued/taken/carry-over days), and *Holiday Requests* (dates→`/holidayRequest/read/`, type, status badge). Injected via `readLocals` querying by `employeeId`.

## [6.7.9] - 2026-06-26

### Fixed
- **Raw `customPermissions.models` Map editor leaked onto the admin User update form** (`mongoose/config/CRUDControllerConfig.js`): the `user` config's `hideFields` listed `customPermissions.models`, but Mongoose registers a `Map` under the wildcard schema path `customPermissions.models.$*`, so the exact-match hide check in `extractSchema` (`CRUDController.js`) never matched and rendered an unusable `Models.$*` field. The sibling `[String]` paths (`customPermissions.departments`/`.routes`) matched exactly and were correctly hidden. Hide entry corrected to `customPermissions.models.$*`.

## [6.7.8] - 2026-06-26

### Changed
- **Extracted shared detail-view partials** to remove duplication across the new per-model read views. `partials/_status-badge.ejs` centralises status→colour mapping (used by the assignment & contract headers and the contract's assignments table), and `partials/_detail-actions.ejs` centralises the permission-gated Update/Delete buttons. `assignment/read.ejs` and `contract/read.ejs` now include both instead of hand-rolling the markup, so future detail views reuse them and styling/permission logic stays in one place.

## [6.7.7] - 2026-06-26

### Changed
- **Redesigned the contract detail page** (`mongoose/views/tailwindcss/contract/read.ejs`, wired via `readView`/`readLocals` in `listControllerConfig.js`). Replaced the generic stacked `form-read` layout with a compact, purpose-built view: title + colour-coded status badge, site location as a subtitle, a responsive meta grid (Start / End / computed Duration / Project / Location / Quote with resolved links), and notes. Added a second card listing the **assignments that belong to the contract** (title, week start, status badge, employee/subcontractor counts) — mirroring the supplier→purchases pattern. `readLocals` resolves the project/location/quote ObjectId refs and queries child assignments.

## [6.7.6] - 2026-06-26

### Changed
- **Generic read view goes full-width when there's no Items/Payments sidebar** (`mongoose/views/tailwindcss/partials/form-read.ejs`): models without `LineItems`/`PaymentLines` (employees, contracts, notes, …) previously left a blank right-hand third and squeezed details into 2/3 width. The details column now spans the full width and the empty sidebar column is no longer rendered. Invoice-style records (purchases, suppliers) keep the existing 2/3 + sidebar layout. Pure widen — no field restructuring.

## [6.7.5] - 2026-06-26

### Changed
- **Streamlined the assignment detail page** (`mongoose/views/tailwindcss/assignment/read.ejs`, wired via `readView`/`readLocals` in `listControllerConfig.js`). Replaced the generic invoice-style `form-read` layout — whose empty Items/Payments sidebar left a large blank column and stacked every field into a tall sparse list — with a compact, purpose-built card: title + colour-coded status badge, contract as a linked subtitle, a responsive meta grid (Week Start / Estimated Hours / Created), and assigned employees & subcontractors rendered as linked chips. `readLocals` resolves the ObjectId refs to name + uuid so the template stays simple.

## [6.7.4] - 2026-06-26

### Fixed
- **CI no longer publishes `:latest` from `master`** (`.github/workflows/ci.yml`): when the default branch moved from `Working` to `master`, master pushes were tagged `branch-master` instead of the rolling `latest` tag the server pulls, so deployments stayed frozen on the previous `Working` build (e.g. v6.7.2 kept rendering the `assignedEmployees` ObjectId-buffer bug even after the fix merged). The tag-derivation step now treats `master` (alongside `main`/`Working`) as a `latest`-producing branch.

## [6.7.3] - 2026-06-26

### Fixed
- **Reference-array fields rendered as raw ObjectId buffers on read/delete views** (`mongoose/views/tailwindcss/partials/_formField.ejs`): fields like an assignment's `assignedEmployees`/`assignedSubcontractors` displayed `{"type":"Buffer","data":[…]}` instead of names. The generic "array-of-objects table" branch matched first (an `ObjectId` is `typeof 'object'`) and dumped each id's internal `buffer`. That branch now skips `ref` fields and BSON `ObjectId`/`Buffer`/`Date` arrays, so they fall through to reference resolution and render as linked names. Affects read, update and delete views for any ObjectId-array ref field.

## [6.7.2] - 2026-06-25

### Changed
- **Rewrote `README.md`** into a full project overview: added Tech Stack, App Structure, `app.js` lifecycle, an 18-feature walkthrough (Dev / User / Business Owner perspectives), and split Development vs Production deployment instructions. Added an explicit proprietary License section ("All rights reserved." — Heron Constructive Solutions LTD).

## [6.7.1] - 2026-06-25

### Fixed
- **Projects financial check no longer fails when the alert email can't be sent**: an SMTP failure (e.g. `ECONNREFUSED ...:465`) previously surfaced as "Financial check failed", discarding the result. The check now completes and reports the at-risk count, with the email-delivery problem shown as a separate warning. `checkProjectFinancials` returns `emailError` instead of throwing on send failure.

### Changed
- **SMTP transport hardening** (`services/emailService.js`): added an explicit `SMTP_SECURE` override (TLS mode independent of port) and connection/greeting/socket timeouts so an unreachable or misconfigured SMTP host fails fast with a clear error instead of hanging. New optional env: `SMTP_SECURE`, `SMTP_CONNECTION_TIMEOUT_MS`, `SMTP_GREETING_TIMEOUT_MS`, `SMTP_SOCKET_TIMEOUT_MS`. Note: `ECONNREFUSED ...:465` is a config issue — switch `SMTP_PORT` to `587` (STARTTLS) for hosts that don't listen on 465.

## [6.7.0] - 2026-06-25

### Fixed
- **Projects Overview "Mark Complete" left stale data**: marking a KashFlow project Complete from `/overview/projects` wrote `Status=Completed` to KashFlow but never refreshed the local REST-namespace copy, so the project kept appearing as active after the redirect. `markProjectComplete` now re-syncs that single project as a by-product of the write.

### Added
- **`hcsSyncService`**: calls hcs-sync's new `POST /api/pull` (authenticated with the shared `HCS_SYNC_API_KEY` via the `X-Sync-Api-Key` header) to re-pull a single entity from KashFlow on demand. If hcs-sync is unreachable, `markProjectComplete` falls back to patching the local project `Status` directly so the overview stays consistent. New env: `HCS_SYNC_BASE_URL` (default `https://sync.heroncs.co.uk`), optional `HCS_SYNC_TIMEOUT_MS`.

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
