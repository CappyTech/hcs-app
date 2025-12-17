# HCS App (HMS)

A full-featured web application by Heron Constructive Solutions LTD for managing subcontractors, CIS compliance, documents, projects, and operational workflows. Built on Node.js/Express with EJS + Tailwind CSS, MongoDB/Mongoose, optional MariaDB integrations, and modern developer tooling.

## Features

- Subcontractor management: profiles, assignments, attendance, pay rates, and documents
- CIS (Construction Industry Scheme): monthly/yearly returns, paid/issued calendars, deductions
- KashFlow REST integration: sync customers, suppliers, invoices, purchases, projects
- Paperless-ngx integration: OCR documents auto-ingest with cross-links to KashFlow entities
- Dashboards: configurable tiles for finance, CIS, HR/payroll, Paperless
- User authentication: sessions, optional TOTP, role-based access
- Security & resilience: CSRF, rate limiting, Helmet, XSS clean, request logging
- Realtime logs: WebSocket updates for operational insight
- API & docs: Swagger/OpenAPI and repository docs for flows and endpoints

## Tech Stack

- Runtime: Node.js (16+)
- Web: Express, EJS, Tailwind CSS
- Data: MongoDB + Mongoose; optional MariaDB via Sequelize
- Testing: Playwright (e2e)
- Infra: Docker Compose + Caddy

## Prerequisites

- Node.js 16 or newer
- MongoDB instance (local or remote)
- Git Bash (recommended terminal for commands and scripts)

## Quick Start

1) Clone and enter the repository

```bash
git clone https://github.com/CappyTech/hcs-app.git
cd hcs-app
```

2) Configure environment variables

- Copy the example env file and update values:

```bash
cp compose.env.example compose.env
```

- If you prefer Windows PowerShell:

```powershell
Copy-Item -Path .\compose.env.example -Destination .\compose.env
```

3) Install dependencies

```bash
npm install
```

4) Run in development (server + Tailwind CSS watch)

```bash
npm run dev
```

5) Run in production mode

```bash
npm start
```

The server prints the port at startup. Access via your configured host and port.

## Configuration

- Application config is primarily via environment variables. See `compose.env.example` and update `compose.env` accordingly.
- Session secrets, database URLs, tunnel settings, and API credentials should be set securely.

## Development Workflow

- Branching: Use feature branches. The active working branch is `Working`. Open PRs to `main` when ready.
- Terminal: Use Git Bash for consistency across scripts and tooling.
- Views: Use Tailwind EJS views under `mongoose/views/tailwindcss`. Do not add views under `mongoose/views/mongoose`.
- Include chain: Trace changes from `app.js`, ensuring routes/middleware include updated files and partials.
- CSS: Tailwind safelist generator helps keep dynamic classes. Build CSS as needed:

```bash
npm run gen:tailwind-safelist
npm run build:css
```

- Watch CSS in dev:

```bash
npm run dev:css
```

## Testing

- Unit tests: Run before committing

```bash
npm test
```

- End-to-end tests (especially when modifying `e2e/`)

```bash
npx playwright test
```

## Project Structure

```
app.js                 # App entrypoint and middleware/router inclusion
assets/                # Source Tailwind CSS
public/                # Built CSS, JS, images, manifest
mongoose/
   controllers/         # CRUD, list, CIS, holiday, paperless, etc.
   config/              # listControllerConfig, CRUDControllerConfig, dashboard tiles
   models/              # Mongoose models across REST and INTERNAL namespaces
   routes/              # Route definitions
   services/            # Mongoose-bound services
   views/
      tailwindcss/       # EJS templates (partials, layout)
services/              # App-wide services (auth, csrf, currency, tax, logger, sockets, etc.)
docs/                  # API and architectural docs
scripts/               # Utilities (tailwind safelist generator)
Dockerfile, docker-compose.yml, Caddyfile, compose.env(.example)
```

## Docker & Caddy

- Use Docker Compose for local orchestration:

```bash
docker compose up -d
```

- Reverse proxy via Caddy is provided. Adjust `Caddyfile` and environment configs to your deployment.

## API Documentation

- Swagger/OpenAPI: Access `/api-docs` when the server is running.
- Additional docs live in `docs/` including CIS-related notes and CURL examples under `docs/rest-curl/`.

## Security Considerations

- Ensure secrets are not committed. Use environment variables for keys and session secrets.
- Helmet, express-rate-limit, xss-clean, and input validation are enabled to reduce risk.
- CSRF protection is enabled where applicable. Review `services/csrfService.js` and related middleware.

## Troubleshooting

- Tailwind classes missing: run `npm run gen:tailwind-safelist` then `npm run build:css`.
- CSS not updating in dev: ensure `npm run dev:css` is running alongside the server.
- Data projection issues: verify `listControllerConfig.js` `fieldOrder` and `hideFields` settings.
- Purchases rendering issues: ensure numeric guards are applied in views to avoid currency formatting errors.

## Repository Guidelines

- Use Node.js 16 or newer
- Install dependencies with `npm install`
- Run unit tests with `npm test` before committing
- If you modify files in `e2e/`, run end-to-end tests with `npx playwright test`
- Ensure `git status` reports a clean working tree before you finish
- Use Git Bash as your terminal
- Trace from `app.js` that files are included via route/middleware chains
- Do not use `mongoose/views/mongoose` — do use `mongoose/views/tailwindcss`

## License

- See the license specified in `package.json`.

## Changelog & Timeline

- See `docs/Project-Timeline.md` for a phase-based summary of work on the `Working` branch, including links to key files and recent highlights.