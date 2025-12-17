# Project Timeline (Working Branch)

## Project Overview

- **Stack:** Node.js/Express, EJS with Tailwind CSS, MongoDB/Mongoose, Playwright (e2e), Docker + Caddy.
- **Domains:** CIS (Construction Industry Scheme), KashFlow REST integration, Paperless-ngx ingestion, HR/payroll, projects, notes, and dashboards.
- **Structure:** Controllers/services under [mongoose/](../mongoose), views under [mongoose/views/tailwindcss/](../mongoose/views/tailwindcss), public assets in [public/](../public), API docs in [docs/](./), and infrastructure in top-level files.

## Key Phases

- **Tailwind Adoption (Jul 2025):** Migrated EJS views to Tailwind; initial redesign passes in partials and layout in [mongoose/views/tailwindcss/layout.ejs](../mongoose/views/tailwindcss/layout.ejs). Introduced slimmer `slimDateTime` usage and improved tables/forms.
- **Realtime & UX Polish (Jul 2025):** WebSocket logs via [services/socketService.js](../services/socketService.js) and [mongoose/services/webSocketServiceMongoose.js](../mongoose/services/webSocketServiceMongoose.js). Multiple UI iterations across list/read views, weekly attendance tables, dashboard tiles, and CIS pages.
- **CIS + HR Enhancements (Jul–Aug 2025):** Reworked CIS views and monthly/yearly returns ([mongoose/views/tailwindcss/cis.ejs](../mongoose/views/tailwindcss/cis.ejs), returns forms). Hardened controllers ([mongoose/controllers/cisController.js](../mongoose/controllers/cisController.js)), holiday services, and attendance logic; secured roles and session handling.
- **KashFlow Integration (Aug–Nov 2025):** Expanded REST syncing and normalization ([services/kashflowNormalizer.js](../services/kashflowNormalizer.js), [kashflowAPI/](../kashflowAPI)). Added docs and curl scripts in [docs/rest-curl](./rest-curl). Linked entities across models (customers, suppliers, projects) via [mongoose/config/listControllerConfig.js](../mongoose/config/listControllerConfig.js).
- **Infrastructure & CI (Oct 2025):** Added Docker/Caddy setup in [docker-compose.yml](../docker-compose.yml), [Caddyfile](../Caddyfile), env templates, and CI workflows. Introduced version bumps and package updates to stabilize deployments.
- **Paperless Integration (Nov 2025):** Auto-ingest and document view improvements ([mongoose/views/tailwindcss/paperless](../mongoose/views/tailwindcss)), plus links back to KashFlow records.
- **Tailwind Build Local (Nov 2025):** Moved from CDN to local Tailwind build; added safelist generator in [scripts/generate-tailwind-safelist.js](../scripts/generate-tailwind-safelist.js) and updated configs ([tailwind.config.js](../tailwind.config.js), [postcss.config.js](../postcss.config.js)).
- **CIS API & Error Handling (Dec 2025):** Added OpenAPI spec for CIS deductions ([docs/API-Swagger.md](./API-Swagger.md)) and refined error page behavior (stack traces only in debug).
- **Supplier Purchases & Read View Refinements (Dec 2025):** Major improvements to supplier read, purchases listing, and array-of-objects rendering; aligned table headers/cells, safer currency formatting, layout reflow to sidebar cards.

## Systems & Features

- **Controllers:** Central CRUD/list logic in [mongoose/controllers/CRUDController.js](../mongoose/controllers/CRUDController.js) and [mongoose/controllers/listController.js](../mongoose/controllers/listController.js). Specialized controllers (attendance, holiday, CIS, logger, paperless).
- **Configs:** Centralized listing rules in [mongoose/config/listControllerConfig.js](../mongoose/config/listControllerConfig.js) and dashboard tiles in [mongoose/config/dashboardTilesConfig.js](../mongoose/config/dashboardTilesConfig.js).
- **Services:** Security, rate limiting, CSRF, auth, currency/tax, logger, sockets, tunnels, migrations under [services/](../services). KashFlow normalizer and session service manage API payload consistency and sessions.
- **Views:** Tailwind components for lists, forms, and detail pages in [mongoose/views/tailwindcss/partials](../mongoose/views/tailwindcss/partials); layout and navigation in [mongoose/views/tailwindcss/layout.ejs](../mongoose/views/tailwindcss/layout.ejs).

## UI/UX Evolution

- **From grid to cards:** Read-only form fields shifted from grid layouts to stacked card-like blocks for clarity in [mongoose/views/tailwindcss/partials/_formField.ejs](../mongoose/views/tailwindcss/partials/_formField.ejs).
- **Sidebar organization:** Details on the left, “Items” and “Payments” in right-side cards in [mongoose/views/tailwindcss/partials/form-read.ejs](../mongoose/views/tailwindcss/partials/form-read.ejs).
- **Visual polish:** Reduced brightness and spacing; adopted `bg-gray-*` with dark-mode variants; standardized tables (`min-w-full`, `divide-y`) to align headers and body cells.
- **Array rendering:** Arrays of objects (e.g., Contacts) now render as concise tables rather than `[object Object]`.

## Data & Models

- **Mongoose models:** REST and INTERNAL namespaces under [mongoose/models](../mongoose/models) with cross-references surfaced via `fieldTransforms` in [mongoose/config/listControllerConfig.js](../mongoose/config/listControllerConfig.js).
- **CIS dates:** `PaymentLines` and paid/issued date logic aligned to HMRC tax-month mapping; normalized date handling across views and dashboards.

## Infrastructure

- **Deployment:** Docker Compose and Caddy reverse proxy configured; environment examples provided; CI workflows added for build/test pipelines.
- **Tailwind build:** Local Tailwind compilation with PostCSS; safelisting ensures dynamic class usage isn’t purged.

## Recent Highlights (Working branch)

- **Supplier purchases:** Enhanced linking, CIS calendar integration, and robust table rendering in [mongoose/views/tailwindcss/partials/form-read.ejs](../mongoose/views/tailwindcss/partials/form-read.ejs).
- **Safe currency formatting:** Guards prevent “Invalid input” errors for non-numeric fields in purchases and related views.
- **Array-of-objects renderer:** Cleaner display for complex fields in [mongoose/views/tailwindcss/partials/_formField.ejs](../mongoose/views/tailwindcss/partials/_formField.ejs).
- **Config-driven lists:** Purchases selection and sorting respect centralized rules in [mongoose/config/listControllerConfig.js](../mongoose/config/listControllerConfig.js).
- **Hide fields honored:** Supplier read purchases projection now respects `hideFields` while keeping necessary extras in [mongoose/controllers/CRUDController.js](../mongoose/controllers/CRUDController.js).
- **Docs & error handling:** CIS OpenAPI spec added; error page shows stack traces only in debug mode.

## Notable Files

- [app.js](../app.js): App entry; routes/middleware inclusion anchor.
- [mongoose/controllers/CRUDController.js](../mongoose/controllers/CRUDController.js): Unified CRUD operations and supplier read enhancements.
- [mongoose/config/listControllerConfig.js](../mongoose/config/listControllerConfig.js): Central listing behavior, labels, transforms, tabs.
- [mongoose/views/tailwindcss/partials/form-read.ejs](../mongoose/views/tailwindcss/partials/form-read.ejs): Read layout with sidebar cards, purchases table.
- [scripts/generate-tailwind-safelist.js](../scripts/generate-tailwind-safelist.js): Keeps Tailwind classes from being purged.
- [docker-compose.yml](../docker-compose.yml), [Caddyfile](../Caddyfile): Runtime infrastructure.

## Next Ideas

- **Filter UI:** Add in-page status/date filters above supplier purchases to complement URL params.
- **Sticky sidebar:** Make “Items” and “Payments” cards sticky on large screens for better browsing.
- **Pagination controls:** Surface page/limit controls in the UI when applied server-side.
- **Consistent docs:** Expand API docs for common endpoints and error contracts; add a short “Working branch” changelog in [docs/](./).
