# Unused Files

> **Generated:** 2026-02-14
>
> Files in this repository that are **not reachable** through any `require()` chain starting from `app.js`. The application loads ~141 files at runtime; the files below are not among them.

---

## Summary

| Category | Count |
|---|---|
| Services (`services/`) | 5 |
| Mongoose routes | 2 |
| Mongoose services | 1 |
| Build scripts / config | 4 |
| Client-side JS (served static) | 3 |
| **Total** | **15** |

---

## Services (`services/`)

### `services/cisService.js`
Pure calculation helper for CIS (Construction Industry Scheme) invoices. Takes labour/material costs, deduction rate, and CIS number and returns computed gross, net, CIS deduction, and reverse-charge amounts. Not imported by any reachable file.

### `services/envValidator.js`
Empty placeholder file. Appears intended for environment-variable validation logic that was never implemented.

### `services/generateTokenService.js`
Thin wrapper around `jsonwebtoken.sign()` that creates a signed JWT from a payload using `JWT_SECRET`, defaulting to an 8-hour expiry. Not imported anywhere.

### `services/tunnelService.js`
Establishes an SSH tunnel (via `tunnel-ssh`) to a remote MongoDB server and connects Mongoose through the local tunnel port. Includes graceful shutdown on `SIGINT`/`SIGTERM`. The database service (`mongooseDatabaseService.js`) has its own inline tunnel logic, making this redundant.

### `services/validationService.js`
Validates invoice form data (invoice number, KashFlow number, dates, costs) and throws an aggregated error if any required fields are missing or malformed. Also nullifies placeholder `0000-00-00` dates. Not imported by any controller or route.

---

## Mongoose Routes

### `mongoose/routes/index.js`
Auto-loader that recursively scans its own directory for `.js` route files, `require()`s each one, and mounts them onto a single Express router. Acts as a barrel/index for all route files. `app.js` mounts each route file individually instead, so this is unused.

### `mongoose/routes/taskRoutes.js`
Defines a single `GET /tasks` route that returns pending tasks for the authenticated user by calling `taskServiceMongoose.getPendingTasksForUser()`. Not mounted in `app.js`.

---

## Mongoose Services

### `mongoose/services/uuidCheckServiceMongoose.js`
Iterates over all Mongoose models and backfills any documents missing a `uuid` field with a newly-generated UUIDv4. The `require()` call in `app.js` is **commented out** (line ~208). Standalone data-integrity utility.

---

## Build Scripts & Config

These files are not loaded at runtime but serve as build-time or one-off utilities.

### `scripts/generate-tailwind-safelist.js`
Standalone CLI script that glob-scans all EJS templates in `mongoose/views/`, extracts CSS class names from `class="..."` attributes, and writes them to `tailwind.safelist.js` so Tailwind doesn't purge dynamically-used classes.

### `scripts/migrate-paymentlines-dates.js`
One-time migration script that connects directly to MongoDB, scans all `purchases` documents with `PaymentLines`, and coerces any `PayDate`/`Date` string values to proper `Date` objects.

### `postcss.config.js`
PostCSS configuration for the Tailwind CSS build pipeline. Loaded by the CSS build toolchain, not by `app.js`.

### `tailwind.config.js`
Tailwind CSS configuration (content paths, theme, plugins). Loaded by the CSS build toolchain, not by `app.js`.

---

## Client-Side JavaScript (`public/js/`)

These files are served as static assets to the browser. They are not `require()`'d by the server but may be referenced in EJS templates via `<script>` tags.

### `public/js/service-worker.js`
Progressive Web App service worker for offline caching / push notifications.

### `public/js/theme-toggle.js`
Client-side dark/light theme toggle logic.

### `public/js/toggleAccordion.js`
Client-side accordion expand/collapse behaviour.
