# GDPR Readiness Checklist (hcs-app)

This document helps confirm GDPR adherence and identify gaps for hcs-app. It covers legal, operational, and technical controls aligned to UK/EU GDPR.

## Scope & Inventory
- Data map: List all personal data processed (Mongo models, sessions, uploads, logs, backups, third-parties).
- Roles: Define controller vs processor; name DPO/contact.
- Cross-border: Document data locations and transfer mechanisms (SCCs/adequacy).

## Lawful Basis & Transparency
- Purposes + lawful basis per dataset (contract/consent/legitimate interests).
- Privacy policy and cookie policy published; link in UI.
- Legitimate interests assessments (where applicable) recorded.

## Consent & Cookies
- Cookie banner blocks non-essential cookies until consent.
- Granular categories; consent stored and can be withdrawn.
- Audit of cookies set by `public/` assets and third-party libraries.

## Data Subject Rights (DSR)
- Access/export: Provide human-readable JSON export via endpoint.
- Rectification: Allow updates or admin workflows.
- Erasure: Implement deletion with audit trail; respect retention/legal holds.
- Restriction/objection: Flags and processing controls documented.
- Response SLA: ≤ 30 days with extension path; contact channel published.

## Security Controls
- TLS enforced; secure cookies; CSRF, rate limiting, auth guards present.
- Encryption at rest (sensitive fields via `ENCRYPTION_KEY`), backups protected.
- Logging hygiene: No passwords/PII in logs; retention limits.
- Breach response: Playbook and notification procedures.

## Retention & Minimization
- Per-model retention schedule defined; automated cleanup jobs.
- Collect only necessary fields; periodic review.

## Vendors & Subprocessors
- DPAs in place; security posture reviewed.
- Incident terms and audit rights documented.

## Records & DPIA
- Records of Processing Activities (RoPA) maintained.
- DPIAs for higher-risk features; mitigations tracked.

---

# Implementation Plan (Targeted to hcs-app)

## 1. Data Mapping Register
- Create `docs/data-register.json` enumerating models, fields, purposes, lawful bases, retention, locations.
- Source from `mongoose/models` and `services/` usage.
- Put this within /admin dashboard tiles.

## 2. Privacy & Cookie Notices
- Add links in layout (`tailwindcss/layout.ejs`) to Privacy and Cookie policies.
- Commit `public/privacy.html` and `public/cookie.html` with current content. 
- Make this ejs not html, etc.

## 3. Cookie Consent
- Integrate a lightweight consent banner that defers non-essential cookies until opt-in.
- Store consent in a strictly necessary cookie and respect choices.
- On the none logged in home page: "By logging into this software, you consent to our cookie, privacy, etc, etc, policies..."

## 4. Data Subject Rights Endpoints
- Add routes under `mongoose/routes/userRoutes`:
  - `GET /me/export` → JSON export of the user’s data.
  - `POST /me/rectify` → Submit correction requests.
  - `POST /me/erase` → Request deletion (queued; admin approve).
- Emit audit logs without sensitive payloads.

## 5. Retention & Cleanup
- Implement retention config (e.g., `services/retentionService.js`).
- Schedule cleanup via existing session cleanup scheduler; add per-collection policies.

## 6. Logging Hygiene
- Review `services/loggerService` usage; redact PII, set max retention (e.g., 30–90 days).

## 7. Security Hardening
- Ensure `ENCRYPTION_KEY` present in production; encrypt sensitive fields before storage.
- Verify TLS and secure cookie flags; maintain `Cache-Control` no-store already configured.

## 8. Operational Documentation
- Add `docs/incident-response.md`, `docs/ropa.json`, and DPIA templates in `docs/dpia/`.
- Add these above, into ejs, under /admin dashboard tiles.

## 9. Verification
- Run an internal audit using this checklist; capture evidence links.
- Create a status section below.

---

# Status Tracking
- Evidence links: policies, RoPA, DPIAs, DPAs, configs.
- Open items:
  - [ ] Cookie consent banner implementation
  - [ ] DSR endpoints wired and tested
  - [ ] Retention schedules defined and enforced
  - [ ] RoPA and DPIA documents completed
  - [ ] Vendor DPAs and transfer assessments
