# HCS App

Web application by Heron Constructive Solutions LTD for subcontractor management, CIS compliance, HR, fleet, attendance, and document workflows. Provider-agnostic — reads synced accounting data from MongoDB without coupling to any specific accounting provider.

> For full architecture, security, and module documentation see [AGENTS.md](AGENTS.md).

## Tech Stack

Node.js 20 · Express · EJS · Tailwind CSS 3 · MongoDB / Mongoose · Docker · Caddy

## Quick Start

```bash
cp compose.env.example compose.env   # configure environment variables
npm install
npm run dev                           # server + Tailwind CSS watch
```

## Testing

```bash
npm test                # unit tests (node --test)
npx playwright test     # e2e tests (only if e2e/ files changed)
```

## Docker

```bash
cp compose.env.example compose.env
docker compose up -d --build
```

Caddy reverse proxy provides automatic HTTPS. Adjust `Caddyfile` for your domain.

## Development Rules

- **Terminal:** Use Git Bash
- **Views:** Only use `mongoose/views/tailwindcss/` — never `mongoose/views/mongoose/`
- **Include chain:** Trace new files back to `app.js` to ensure they are loaded
- **CSS:** Run `npm run gen:tailwind-safelist` then `npm run build:css` if dynamic classes are missing
- **Tests:** Run `npm test` before committing; run `npx playwright test` if `e2e/` files changed
- **Clean tree:** Ensure `git status` reports a clean working tree before finishing

## Project Structure

```
app.js                  # Entry point — middleware chain, route mounting
assets/                 # Source Tailwind CSS
public/                 # Built CSS, JS, images, manifest
mongoose/
  controllers/          # CRUD, list, CIS, holiday, paperless, fleet
  config/               # RBAC, CRUD/list configs, dashboard tiles
  models/mongoose/      # Schemas: REST/, INTERNAL/, PAPERLESS/
  routes/               # Express route files
  services/             # DB connections, sessions, domain services
  views/tailwindcss/    # EJS templates + partials
services/               # Auth, CSRF, encryption, logging, email, security
docs/                   # API docs, CURL examples, architectural notes
scripts/                # Utilities (tailwind safelist, migrations)
```

## License

See `package.json`.

- See `docs/Project-Timeline.md` for a phase-based summary of work on the `Working` branch, including links to key files and recent highlights.