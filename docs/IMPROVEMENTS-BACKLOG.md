# Improvements Backlog

Remaining items from the June 2026 feature-improvement review. The first batch
shipped in **v6.5.0** (job scheduler, notification outbox, holiday request
workflow, CIS/GDPR/fleet reminders, security audit log, runtime maintenance
toggle, 2FA backup codes, connection tests, CSV export, duplicate purchase
guard, attendance payroll-locking, opt-in deleted-items purge). A second batch
shipped in **v6.6.0** (bank-holiday auto-sync, HR contract/right-to-work
expiry reminders, policy review reminders, holiday carry-over, UTR/NINO/
verification-number validation, per-role 2FA enforcement, HIBP
breached-password check, revoke-all-sessions, Mongo-backed rate limiter, CSP
report-uri). Everything below is **not yet done**, grouped by module with
prerequisites noted.

Most email-based items are now small: enqueue via
`services/notificationService.js` and (if recurring) register a job in
`mongoose/services/jobRegistry.js`.

---

## CIS

- [ ] **CIS300 electronic submission to HMRC** — build the CIS300 monthly
      return XML and submit via the Government Gateway transaction engine.
      `services/hmrcRtiService.js` already implements the GG SOAP envelope,
      polling, and credential handling for FPS/EPS; reuse that plumbing.
      *Prerequisite: HMRC test-in-live validation before first real submission.*
- [ ] **Subcontractor verification requests** — same Gateway channel; would
      replace manual verification-number entry.
- [ ] **Monthly payment & deduction statements** — generate per-subcontractor
      statements after each tax month and email them (outbox exists; needs a
      statement template + job).

## Payroll

- [ ] **Payslip generation + emailing** — per-employee payslip (HTML/PDF) from
      `payrollEntry` data, emailed on run submission.
- [ ] **P45 / P60 year-end documents.**
- [ ] **Statutory payments** — SSP/SMP calculation support in
      `payrollCalculationService`.
- [ ] **Pension auto-enrolment assessment** — assess eligibility per run and
      feed the existing People's Pension upload.
- [ ] **Gateway delayed-acknowledgement polling** — poll for late HMRC
      responses instead of relying only on the synchronous reply (could run as
      a scheduler job).

## Holiday

- [ ] **Team calendar view** — month grid of approved/pending requests for
      managers; clash detection.
- [ ] **Employee entry point** — employees can reach `/holidayRequests` but
      have no dashboard tile (tiles are department-based and 'attendance' would
      also show it to subcontractors). Needs either an employee-only department
      or per-role tile filtering.

## Fleet

- [ ] **DVLA VES API integration** — auto-populate MOT/tax expiry from the
      registration number instead of manual entry. *Prerequisite: free DVLA
      API key.*
- [ ] **Fuel economy / cost-per-mile reporting** — derive from existing
      `vehicleFuelLog` + `vehicleMileageLog` data on the fleet overview.

## Paperless / PICP

- [ ] **Post-consume webhooks** — replace manual/polled ingestion with
      Paperless-ngx webhook push. *Prerequisite: webhook config on the
      Paperless side (docs.heroncs.co.uk).*
- [ ] **OCR amount sanity-check** — warn when a draft's total is an outlier
      vs the supplier's purchase history before sending.
- [ ] **Split `paperlessController.js`** (1,599 lines) into ingest / match /
      draft services.

## KashFlow integration

- [ ] **API log admin view** — surface `kashflowApiLogService` data
      (failures, latencies) in the admin UI instead of logs only.
- [ ] **Retry/backoff on session expiry** for purchase creation beyond the
      current single re-auth.

## Financial data browsing

- [ ] **Saved filters per user** on list views.
- [ ] **Aged debtors/creditors view** — bucketed overdue invoice/purchase
      report from synced REST data.

## Projects

- [ ] **Per-project profitability** — invoices minus purchases minus CIS
      labour per project number (all three datasets already synced).
- [ ] **Margin trend** on the projects overview.

## HR

- [ ] **Certification expiry reminders** — contract end and right-to-work
      shipped in v6.6.0 (`hrComplianceService`); certifications need an
      array sub-document on the employee model plus a management UI (the
      generic CRUD form can't edit arrays of objects), then extend
      `hrComplianceService.itemsForEmployee`.
- [ ] **Onboarding checklist** tied to the employee model.

## Company docs / Policies

- [ ] **Acknowledgement tracking** — staff "read & understood" sign-off with
      audit trail per policy version.
- [ ] **Version diff view.**

## Overview dashboards

- [ ] **Cache expensive aggregations** (each overview service recomputes per
      request).
- [ ] **Date-range selection.**
- [ ] **PDF export** for finance/payroll overviews.

## Auth / Security

- [ ] **WebAuthn / passkeys.**
- [ ] **2FA remember-this-device option.**
- [ ] **SSO single logout** — destroying the hcs-app session should
      invalidate the hcs-sync cookie.

## GDPR

- [ ] **Automated SAR export** — bundle a user's data across
      INTERNAL/PAPERLESS namespaces as JSON/PDF for access/portability
      requests.
- [ ] **Retention enforcement jobs** — auto-delete/anonymise per the RoPA's
      stated retention periods (scheduler exists; needs per-collection
      policies agreed first).

## Notifications

- [ ] **In-app notification bell** — surface the outbox/in-app events in the
      layout header.
- [ ] **Per-user notification preferences** (which categories to receive).

## Admin / Platform

- [ ] **Log viewer improvements** — server-side level/module filtering,
      download, retention policy.
- [ ] **Feature-flag system** — `features` section in app-config.json gating
      route mounting + dashboard tiles per module (CIS, fleet, payroll,
      attendance, paperless, …), as discussed in the feature-toggle review.
- [ ] **Setup wizard end-of-run health summary.**

## Testing

- [ ] **Controller/route tests** — supertest + in-memory Mongo for the
      largest controllers (paperless, attendance, userCRUD, CRUD). The unit
      suite (571 tests) covers services only.

---

*Created 2026-06-11 after the v6.5.0 batch; last updated 2026-06-12 after
v6.6.0. Remove items as they ship and record completions in CHANGELOG.md.*
