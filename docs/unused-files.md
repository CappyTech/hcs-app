# Unused Files

> **Generated:** 2026-02-14
>
> Files in this repository that are **not reachable** through any `require()` chain starting from `app.js`. The application loads ~141 files at runtime; the files below are not among them.

---

## Summary

| Category | Count |
|---|---|
| KashFlow API (entire module) | 9 |
| Services (`services/`) | 6 |
| Mongoose routes | 2 |
| Mongoose services | 1 |
| Build scripts / config | 4 |
| Client-side JS (served static) | 3 |
| **Total** | **25** |

---

## Services (`services/`)

### `services/cisService.js`
Pure calculation helper for CIS (Construction Industry Scheme) invoices. Takes labour/material costs, deduction rate, and CIS number and returns computed gross, net, CIS deduction, and reverse-charge amounts. Not imported by any reachable file.

### `services/databaseMigrationService.js`
Generic one-way data migrator that reads all records from a Sequelize model, applies a transform function, and upserts them into a corresponding Mongoose model by a configurable unique key. Leftover from a Sequelize-to-Mongoose migration.

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

## KashFlow API (`kashflowAPI/`)

The entire `kashflowAPI/` directory is unreachable from `app.js`. It contains a SOAP-based data-sync pipeline that fetches accounting data from the KashFlow API and upserts it into Sequelize/Mongoose. None of its routes are mounted.

### `kashflowAPI/fetchKashFlowData.js`
Main (current) KashFlow data-sync orchestrator. Authenticates via SOAP, fetches customers/suppliers/projects/invoices/quotes, upserts them into the Sequelize DB, and spawns worker threads to process supplier receipts in parallel (capped at 3 concurrent).

### `kashflowAPI/fetchKashFlowData-old.js`
**Legacy version** of `fetchKashFlowData.js`. Same SOAP fetch-and-upsert workflow but includes its own inline `upsertData` function, processes receipts sequentially (no worker threads), and has extensive commented-out debug logging.

### `kashflowAPI/fetchKashFlowData-old-old.js`
**Oldest legacy version** of `fetchKashFlowData.js`. Uses Sequelize (`sequelizeDatabaseService`), a simpler `upsertData` with no change-detection, a callback-style `authenticate`, and runs as a self-executing IIFE.

### `kashflowAPI/indexSeq.js`
Early standalone script version of the KashFlow fetch using Sequelize with basic upsert and no change-detection or worker threads. Superseded by `fetchKashFlowData.js`.

### `kashflowAPI/routes.js`
Express router exposing a `GET /fetch-kashflow-data` endpoint (authenticated via a query-string token) that triggers the KashFlow data fetch and streams progress as chunked plain-text. Several other routes are commented out.

### `kashflowAPI/updateTaxMonthTaxYear.js`
Finds all Sequelize `KF_Receipts` records with null `TaxMonth`/`TaxYear`, calculates the tax month/year from the first payment date, and updates them in-place. The route that would call it is commented out.

### `kashflowAPI/upsertData.js`
Current upsert module for the KashFlow pipeline. Compares incoming data against existing Sequelize records field-by-field (skipping placeholder dates and normalizing timestamps), only writes on real changes, and also syncs new receipts to MongoDB.

### `kashflowAPI/upsertData-old.js`
**Legacy version** of `upsertData.js`. Similar field-by-field change detection but lacks the MongoDB sync step and uses slightly different normalization logic (boolean/integer coercion instead of timestamp truncation).

### `kashflowAPI/workerProcessReceipts.js`
Worker-thread script spawned by `fetchKashFlowData.js`. Authenticates independently, fetches receipts/payments/notes for a single supplier, normalizes and transforms them, then upserts into both Sequelize and Mongoose. Communicates progress back to the parent via `parentPort`. Also imports `services/kashflowNormalizer.js` (which is otherwise unused).

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
