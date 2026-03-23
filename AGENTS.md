# hcs-app — The Platform

hcs-app is the main web application for **Heron Constructive Solutions LTD**. It is the central platform for CIS compliance, HR, fleet management, attendance, document handling, and dashboards.

**hcs-app is provider-agnostic.** It reads financial data from the **REST** MongoDB namespace without knowing or caring which sync service wrote it. Today that's KashFlow via [hcs-sync](https://github.com/cappytech/hcs-sync); tomorrow it could be Xero, QuickBooks, or any other adapter that conforms to the same REST schema contract. hcs-app also manages its own namespaces (**INTERNAL** for users, employees, attendance, etc. and **PAPERLESS** for OCR documents).

Where hcs-app does call an external API directly (e.g. `kashflowVatService.js` for VAT rates, `paperlessController.js` for Paperless-ngx cross-referencing), those are **hcs-app's own integrations** — not shared with any sync service.

---

## Repository Guidelines

- Use Node.js 20.
- Install dependencies with `npm install`.
- Run the unit tests with `npm test` before committing.
- If you modify files in the `e2e/` folder, run the end-to-end tests with `npx playwright test`.
- Ensure `git status` reports a clean working tree before you finish.
- Use Git Bash as the terminal.
- Trace from `app.js` that any new file is included at some point, or is a child of another file that is included in `app.js`.
- Do **not** use `mongoose/views/mongoose/` — always use `mongoose/views/tailwindcss/`.
- The `kashflowAPI/` folder is unused. Data sync is handled by [hcs-sync](https://github.com/cappytech/hcs-sync).
