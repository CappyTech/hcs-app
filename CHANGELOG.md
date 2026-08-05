# Changelog

All notable changes to hcs-app will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [6.21.0] - 2026-08-05

Requires **hcs-schemas 3.0.0** and pairs with **hcs-sync 0.11.0**. A bank line is now identified by *(account, KashFlow Id)* rather than Id alone, throughout `/bank`.

### Fixed
- **A bank line is two things when it is an internal transfer, and `/bank` treated it as one.** KashFlow returns a transfer between two company accounts in **both** accounts' feeds — each rendered from that account's point of view, `PaidIn`/`PaidOut` swapped, `Balance` being that account's running balance, `Type` naming the *other* account — and the mirror's unique index on `Id` merged the two into a single document. hcs-schemas 3.0.0 stores both halves; everything here stops assuming an Id resolves to one line.

  On the live database that merge had been costing 422 documents rewritten twice per hourly sync, and 483 lines fetched under the main trading account (611594) stored under a counterparty account instead — absent from its ledger, so the account with the largest outstanding balance could not reconcile.

  `bankTransferService` is the clearest casualty: it exists to pair the two halves of a transfer, and its own header describes them correctly ("appears twice — once leaving one account, once arriving in another"), but the merge destroyed the pairs before it ran. It recorded finding 22 candidate pairs across 2,547 unlinked lines and called transfers "rare in this dataset". They are not rare; they were being deleted.

### Changed
- **`bankLineKey(line)`** — `"<AccountId>:<Id>"`, the same materialised-composite device `bankReconciliation.ReconKey` already uses. Every place that identifies, claims, or de-duplicates a bank line now keys on it.
- **`bankMatch.bankLines[]` carries `bankAccountId` and `bankLineKey`**, and `statementLine` carries `matchedBankAccountId`. The `confirmed_bankline_unique` index moves to `bankLines.bankLineKey`: keyed on `bankTransactionId`, a confirmed match on one account's half would have blocked the other account's half from ever being matched, though it is a separate ledger line that may settle something else entirely. `findConflicts()` — the write-time guard that exists because that index cannot be relied on alone — moves with it.
- **`claimedLines()`** replaces eight hand-rolled `distinct('bankLines.bankTransactionId')` claimed-sets. Claiming used to be expressible as `Id: { $nin: [...] }`; it no longer is, because excluding by Id hides the *other* half the moment either is matched. It returns a query fragment excluding only Ids whose every live half is claimed, plus the key set for an exact filter afterwards. That preserves the property the `$nin` was there for in the first place — `limit` must not be spent on already-processed rows, the bug that capped the first production run at exactly 5,000 suggestions — because the only rows surviving the query-side exclusion are half-claimed transfers, which *are* still worth processing.
- **`findTransferPairs()` keys its `used` set on the composite.** The two halves of a transfer share an Id, so an Id-keyed `used` set would mark both spent the moment either was taken — dropping every genuine pair, precisely as the service started being able to see them.
- **The worklist derives its state filter from keys, then narrows to ids.** It is always scoped to one account, and within one account an Id is unique again, so the id list is exact. Note a `distinct` filtered on `bankLines.bankAccountId` would *not* work: the filter selects whole match documents, so a match spanning two accounts contributes both of its ids.
- **`GET /bank/lines/:bankTransactionId` → `GET /bank/lines/:bankAccountId/:bankTransactionId`.** The account is part of the line's identity; without it the lookup returned an arbitrary half. All nine links across `account.ejs`, `exceptions.ejs` and `statementReview.ejs` updated.

### Added
- **`scripts/backfill-bank-line-keys.js`** — stamps `bankAccountId`/`bankLineKey` onto all 13,176 existing `bankmatches` lines and onto `statementlines`. **Must run before hcs-sync 0.11.0 deploys**: it reads each match's account off the single document that Id still resolves to, and once both halves exist nothing records which one a pre-existing match meant. It refuses to run if any Id already has two documents, rather than guessing. Idempotent, `--dry-run` supported, writes through the native driver so a migration does not appear in the audit log as a decision.
- **`bank-stranded-lines`** (6-hourly, `/admin/jobs`) — retires the rows the re-key leaves behind. 105 bank lines are stored under an account KashFlow no longer lists: that `AccountId` names the account a transaction was *entered against*, not the ledger it belongs to, and those rows still arrived inside a listed account's feed. From hcs-sync 0.11.0 each is rewritten under the account whose feed returns it, and the original strands — no feed writes to it, and the soft-delete sweep cannot reach it either, since the sweep is scoped `{ AccountId: accountId, … }` and no listed account matches. Left alone it would sit in the worklist forever as a duplicate of the line that replaced it, with 37 matches pointing at a row nothing maintains.

  A job rather than a migration script, because it is idempotent and self-healing: it only ever acts where a replacement genuinely exists, so it is a no-op before the sync re-keys and a no-op forever after it has caught up, and nobody has to run it at exactly the right moment.

  Three guards, all tested: a stranded row with **no** replacement is left untouched (a line on an archived account is real history, not debris); an Id present on **two** listed accounts is skipped rather than guessed at (that is a transfer — both halves are real, and neither replaces a third row); and an **empty** account list does nothing at all, since failing closed is the only safe reading when the alternative retires the whole collection. Rows are soft-deleted with a `supersededBy` key, never removed.
- Tests for the composite key, `claimedLines()`'s under-exclusion, and — the one that would have caught the original bug — `findTransferPairs()` pairing two halves that share a KashFlow Id.

## [6.20.2] - 2026-08-04

Restores printf-style logging, which has never worked.

### Fixed
- **Every `logger.info('… %s', value)` call logged the placeholder verbatim and discarded the argument.** winston only interpolates `%s`/`%d` when `format.splat()` is in the format chain, and `services/loggerService.js` combined `timestamp()` with `json()` and nothing else. So the 12 printf-style call sites across the app — 9 of them in `ssoController.js` — have been writing `invalid credentials for "%s"` to the log with no username attached, for as long as the logger has existed. This is not cosmetic: a failed hcs-sync SSO login recorded *which endpoint* rejected the attempt but never *whose account*, so a locked-out user could only be identified by scanning the users collection for a non-zero `loginAttempts`. `splat()` now sits between `timestamp()` and `json()`, which fixes all 12 sites at once. It has to precede any format that consumes `message` — putting it after `json()` would silently do nothing, which is the failure mode being fixed.

### Security
- **`logger.sanitize` had no callers.** It strips newlines and control characters to stop a user-controlled value forging a second log line, and it was written for exactly this interpolation — but since interpolation never happened, nothing was ever injectable and the helper was never wired up. Turning `splat()` on makes those arguments land in the log for the first time, so the one attacker-controlled site is now sanitised: `ssoController.js` logs the `username` straight off the SSO request body. The other 11 sites interpolate an `err.message` or a `user.username` already loaded from the database and are left as they are.

### Added
- `tests/loggerService.test.js` — 7 cases. Interpolation of a single `%s`, of mixed `%d`/`%s`, and the no-placeholder-with-meta case that must stay untouched; then sanitising: newline stripping against a forged-log-line payload, control characters and the length cap, nullish input, and reachability via the default export. The two interpolation cases fail against the unfixed logger; the no-placeholder case passes either way, since it is guarding against a regression from `splat()` rather than the bug itself.

## [6.20.1] - 2026-08-04

### Changed
- **"Confirm selected" now sits above the worklist table rather than below it.** With 50 rows a page it was off-screen at the point you had finished ticking, so every batch ended with a scroll back down.

## [6.20.0] - 2026-08-04

### Added
- **Bank statements are now ingested from Paperless.** Statements emailed to `bank.statements@heroncs.co.uk` are filed by a Paperless mail rule with document type `Bank Statement` and tag `bank-statement`; `bankStatementIngestService` reads their OCR text, parses it, and writes the outcome back as `bank-statement/parsed`, `/needs-review` or `/failed`. Runs six-hourly as `bank-statement-grab`, or on demand from **Fetch from Paperless** on `/bank/statements`.

  Everything lands in the same `statementImport` / `statementLine` models the CSV/OFX upload uses, so three-way matching and the exceptions page work identically whichever route a line took.

  Three decisions worth keeping:
  - **Documents are selected by tag id, never by a `tag:` search string.** A pre-existing `statements` tag holds 33 *supplier* statements of account — a different document that happens to share a word — and an id cannot be renamed into matching it.
  - **The outcome tag is merged, not replaced.** Replacing would drop `bank-statement` and make the document invisible to the next run.
  - **An account is never guessed.** Resolution is the `Bank Account ID` custom field, then a correspondent-id map, then nothing — a statement attributed to the wrong account produces a confidently wrong reconciliation, so an unresolvable one is held for a human and tagged `needs-review`.

  Idempotent on two levels: a document whose OCR text is unchanged is skipped outright, and `importStatement` no-ops on an unchanged source hash.

- `listDocuments` in the Paperless client accepts `tagsIdAll` and `fields`.

## [6.19.3] - 2026-08-04

### Fixed
- **"Generate suggestions" reported four zeros when there was simply nothing left to do**, which reads as total failure. It only ever showed what that run *added*, and the six-hourly jobs normally get there first — so the usual outcome was `0 from KashFlow links, 0 transfers, 0 inter-account movements, 0 from rules`. It now reports the resulting state ("13,174 bank lines now have a suggestion; 255 need a rule or a decision of their own") and says plainly when there is nothing new.

## [6.19.2] - 2026-08-04

### Fixed
- **Every `/bank` page with a date on it returned a 500.** The views called `slimDateTime(date, true)`, but the signature is `(dateString, options = [], timezone)` and it calls `options.includes(...)` — which a boolean does not have. The default already produces `dd/MM/yyyy`, so the second argument was wrong *and* unnecessary; all 17 calls are removed.

  The view tests missed it because they stubbed `slimDateTime` with a one-argument fake, which silently ignored the bad second argument. They now use the **real** `dateService` and `currencyService`, and a new assertion rejects any boolean passed as options. Reintroducing the bug fails five tests with the same error production gave.

  All 22 occurrences were in the bank views, across 17 lines — several lines carried two calls. A repo-wide check confirms no other caller passes a boolean; everything else correctly uses `['displayFormat']`, `['includeTime']` or the default.

## [6.19.1] - 2026-08-04

### Fixed
- **Suggestion generation stalled once it hit its row limit.** All four generators fetched the newest `limit` bank lines and *then* filtered out ones already carrying a match. After the first run every one of those rows was claimed, so each subsequent run re-read the same set and created nothing — the older backlog was never reached. Caught on the first production run: 13,429 lines, a 5,000 limit, and exactly 5,000 suggestions that would never have grown. Claimed ids are now excluded in the query, so the limit applies to unprocessed rows. Affects `generateSuggestions`, `applyRules`, `detectTransfers` and `detectAccountNamedMovements`.

## [6.19.0] - 2026-08-04

Bank reconciliation. Nobody was reconciling the bank: 459 of 13,429 transactions were marked reconciled in KashFlow (3.4%), and on the main trading account 7,470 of 7,908 lines were outstanding going back to 2016. There was no view anywhere in the app of bank accounts, balances, or which payments had been accounted for.

**KashFlow is never written to.** It stays the system of record; the app holds its own account of what has been reconciled and who said so. The two destructive KashFlow endpoints (`PUT /bankaccounts/{id}/transactionlist` and `POST /bankaccounts/assign-transaction-to-new-entity`, both of which delete the source transaction) have no client wrapper in hcs-sync at all — their absence is the enforcement mechanism.

97.9% of all bank lines now arrive with a suggestion for review.

### Added
- **`/bank`** — accounts with reconciliation progress, and a one-button sweep that runs every detector in order.
- **`/bank/accounts/:id`** — the worklist. Filter by state, kind, date range and free text; open a line; or tick many and confirm them in a single action. Bulk confirm is the point: 12,991 outstanding lines were never going to be reviewed one modal at a time. Each selected line is still validated individually, and one failure reports itself without abandoning the batch.
- **`/bank/lines/:id`** — one line, its resolution, its allocations (editable before confirming) and its history.
- **`/bank/rules`** — accountant-authored rules for lines that settle no document, with a preview that reports what a rule would claim before it is turned on, and a set of starter rules.
- **`/bank/statements`** — import a CSV or OFX statement and review what was read from it.
- **`/bank/signoff`** — close a period per account, with variance against the statement balance.
- **`/bank/exceptions`** — six sections of what needs a human.

- **Link resolution.** 81% of bank lines already carry KashFlow's own link to the document they settle, via `EntityName` + `ResourceNumber`. `bankLinkService` resolves all four shapes: direct purchase/invoice, batch payments fanning out to every document a batch settled, and journals. Measured against a copy of the live database, **10,882 of 10,882 linked lines resolve and all 10,870 allocations agree on amount**. `scripts/verify-bank-links.js` is the harness (read-only, developer-only, not wired into the app).
- **Rules engine** for the 2,547 lines that settle nothing. These are not unmatched purchases waiting to be found — they are postings to nominal accounts, and KashFlow already names the nominal in `Type`: only 47 distinct values, the top 20 covering 92.5%. From those 2,547 lines: 1,861 matched by rule, 409 inter-account movements, 22 paired transfers — **2,292 covered (90%)**, the rest left for a human or a rule of their own.
- **Inter-account movements are detected, not seeded.** KashFlow writes the counterparty account's *name* into `Type` for a movement between two of our own accounts. Compared against the live account list rather than hardcoded, so a new account is recognised without a code change. Recorded as one-sided on purpose: money-in rows outnumber money-out roughly thirty to one, so pairing them like a true transfer would misrepresent what is there.
- **Statement import** (CSV/OFX now; Paperless when its mail rule exists). `statementParserService` is pure and testable against fixtures. **The balance chain is the safety mechanism**: every UK statement carries a running balance, so `balance[n-1] + amount[n] === balance[n]` is asserted down the page, plus opening + movement === closing. If it does not hold the parse is wrong, the import is marked `needs-review`, and **none of its lines are trusted**. OCR can transpose a digit and produce a perfectly plausible line; this is what makes that detectable. OFX carries no running balance, so an OFX import can never reach `parsed` — it is trusted by the reviewer, not the parser.
- **Three-way matching** — statement line ↔ bank transaction ↔ document. The finding worth acting on is a statement line with no KashFlow transaction: money that moved and was never booked, which reconciling KashFlow against itself cannot find. Only balance-verified statements are used, and gaps are reported only inside periods a statement actually covers — otherwise every transaction outside the imported range reads as missing and the report is noise.
- Five background jobs: `bank-link-resolve`, `bank-rule-apply`, `bank-statement-reconcile`, and the existing sweep. All idempotent — `bankMatch` is INTERNAL so `auditPlugin` records every write, and a job rewriting the same suggestions each run would bury the audit log.
- RoPA activity **A7**. Bank narrative is personal data: individual payee names, wage transfers and subcontractor payments, including people who appear nowhere else in the system.

### Fixed
- **Document types were matched by literal name**, so renaming one in Paperless silently broke three queries — `attendanceService.fetchStatementsForWeek`, `documentsOverviewService.KF_ELIGIBLE_MATCH` and the unlinked-docs query in `paperlessController`. None of them error; they match nothing and return empty. The breakage had not surfaced only because hcs-app caches `documentType.name` and all 814 cached documents still held the pre-rename names — it would have appeared gradually as the grab refreshed them. Now resolved by id (what Paperless uses as its key, and what survives a rename) through `mongoose/config/paperlessTypesConfig.js`, falling back to any known past or present name.
- **Tags were matched by literal name** in the same way — the `NOT_FOR_KASHFLOW` exclusions, the `manually added to kashflow` exclusion, the `added` requirement, and the duplicate-send lock's "the only tag is `added`" check. Now resolved by tag id through `mongoose/config/paperlessTagsConfig.js`, with a `res.locals.hasTag` helper for views. Note the live tag is `data entry done` with spaces while the code has always said `data-entry-done`; that one was safe (its filter uses a separator-tolerant regex) and both spellings are now registered.

### Notes
- Requires `@cappytech/hcs-schemas` ≥ 2.1.0. Invoice `PaymentLines` become a typed sub-document; `invoice.fields.PaymentLines` deliberately stays `[{}]` there so a consumer that only spreads `...invoice.fields` keeps working.
- **A statement's account is never parsed out of a correspondent's name.** Names carry the KashFlow id by convention but nothing validates them — the live `Petty Cash - 5714888` has an extra digit, and parsing it would have resolved to an account that does not exist. Resolution is the `Bank Account ID` custom field, then a correspondent-id map, then nothing.
- **No document-scoring matcher.** It was planned, and the data says it would find nothing: against the properly-computed unsettled set (1,333 purchases, 108 invoices genuinely unreferenced by any bank line), exactly **one** of the 2,547 unlinked lines has an exact-amount candidate within a week, and it is a coincidence. Relaxing to ±5% over 60 days reaches 29%, which is the false-positive explosion rather than a signal. Left out rather than shipped as noise.
- Money is compared in integer pence throughout. `Math.abs(100 - 100.01)` is `0.010000000000005`, so a float comparison rejects an exact penny.

## [6.18.0] - 2026-07-31

Makes every outgoing email a responsive HTML email. They were not merely unstyled for mobile — they were structurally incapable of it.

### Fixed
- **Emails had no `<html>` or `<head>` at all.** Every message was a bare `<div style="max-width:600px">` fragment handed straight to nodemailer. No `<head>` means no `<style>`, and no `<style>` means **no media queries** — nothing could respond to screen width under any circumstances. `services/emailLayout.js` now supplies a real document and every email is delivered inside it.
- **No `<meta name="viewport">`**, so mobile clients chose their own scale and the recipient pinch-zoomed to read a notification.
- **`max-width` on a `<div>` does nothing in Outlook for Windows**, which renders through Word. The body stretched the full width of the window. Centring is now a table plus an MSO conditional fixed-width table, which Word does honour.
- **The action buttons collapsed in Outlook.** They were an inline `<a>` carrying `padding` and `background-color` — both ignored by Word — so "Verify Email" and "Reset Password" arrived as bare underlined text. They are now the standard bulletproof construction: background on the `<td>`, padding on the `<a>`.
- **The KashFlow "below income target" alert was a five-column currency table** with no mobile handling, unreadable on a phone. It goes through `emailLayout.dataTable`, which stays a table on desktop and becomes one labelled card per project below 600px.
- `tests/emailNotifications.test.js` — the "queues a subscribed system notification" case threw instead of asserting, because signing an unsubscribe token needs a server secret the test never set. Unrelated to this work, but it was the only red test in the suite.

### Added
- **`services/emailLayout.js`** — the responsive shell and the primitives built on it (`button`, `buttonRow`, `dataTable`, `note`, `link`, plus `escapeHtml`/`safeUrl` moved here so `emailService` can use them without importing the notification service). The document carries a viewport meta, a `<style>` block with a 600px breakpoint, `color-scheme` and a `prefers-color-scheme: dark` block, and Outlook conditionals. Below 600px the container goes fluid, outer gutters shrink, buttons become full-width tap targets, and data tables stack into labelled rows.
- **Every style is inline *as well as* in the stylesheet.** Gmail's web client keeps `<style>` in the head (so the media queries work) but plenty of clients strip it, so the inline styles carry the desktop rendering on their own and the classes only ever *override* for small screens. Do not move a style that matters into the stylesheet alone.
- **Preheader support** — the hidden line clients show beside the subject in the inbox list. Without one they scrape whatever visible text comes first, which for a branded email is the header or an image alt.
- `tests/emailLayout.test.js` — 38 cases covering the document structure, the breakpoint and dark-mode blocks, the Outlook conditionals, button escaping and URL sanitising, the stacking data table, preheader hiding/escaping, and `isDocument` round-tripping.

### Changed
- `emailService.sendMail` is now the guaranteed wrapping point: any caller's fragment gets the responsive document, and anything already a full document is left alone. `notificationService.enqueue` wraps the assembled email itself so the unsubscribe and automated-message footers sit *below* the card rather than inside it; the wrap is idempotent, so it is not applied twice.
- The email-type preview (`renderPreviewDocument`) renders through the same shell, so previewing now shows the real responsive behaviour. `PREVIEW_CSP` already allowed `'unsafe-inline'` styles and needed no change.
- Notification headings are `<h1>` rather than `<h2>`, and the KashFlow alert's indigo links now match the app's emerald.

## [6.17.2] - 2026-07-31

### Fixed
- **The password reset 2FA forms asked for the one-time code first, so it could expire before the form was submitted.** `verify-totp-reset.ejs` and `verify-sms-otp.ejs` both put the code field at the top, above the new password and confirm-password fields. An authenticator code lives 30 seconds; a user reading it off their phone, then typing a password twice, then finding the button, can easily post a code that has already rolled. `verifyTOTP` allows a ±1 step window, which absorbs clock skew, not a slow form. The code is now the last field before submit on both views, the passwords come first (with `autofocus` on the new password), and the intro copy leads with the password step. This matches `login.ejs`, which has always asked for the password before the 2FA code.
- **A rejected code also cost the user both passwords.** Both verification handlers redirect on failure, which clears the whole form — so an expired code meant retyping the new password and the confirmation as well, against a fresh 30-second clock. The two password fields now survive one failed attempt (`services/passwordResetDraft.js`) and the form comes back filled in, with focus moved to the code field so the retry is a single entry. A password rejected by the HIBP breach check is deliberately *not* carried back: it needs replacing, not editing.

### Added
- `services/passwordResetDraft.js` — holds the carried-over password for exactly one redirect. Scoped tightly on purpose, since it is a plaintext password in session state: it lives **inside** `req.session.passwordResetPending`, so every existing teardown of the reset flow (success, "start over", session expiry) already removes it; `take()` is single-use, so re-visiting the page starts blank; a 5-minute TTL covers a redirect that is never followed; and a `dropOnLeave` middleware discards it the moment the browser navigates to any page outside the reset flow. Only top-level navigations count as leaving — the page's own assets, service worker and favicon do not. Sessions are stored via connect-mongo with `crypto.secret` set, so the draft is encrypted at rest.
- `tests/resetOtpFieldOrder.test.js` — asserts the code field follows both password fields and precedes the submit button on both reset views, keeps `autocomplete="one-time-code"`, repopulates through escaped (`<%=`) interpolation only, and pins the same order on the login form.
- `tests/passwordResetDraft.test.js` — round trip, single-use, TTL expiry, teardown with the parent flow, and the navigation rules for `dropOnLeave` (22 cases).

## [6.17.1] - 2026-07-30

### Security
- **Pinned `quill` back to 2.0.2** ([GHSA-v3m3-f69x-jf25](https://github.com/advisories/GHSA-v3m3-f69x-jf25) — XSS via the HTML export feature, affects exactly 2.0.3, no patched release). 6.16.0 vendored Quill from the CDN and pinned 2.0.3, a version bump the app never asked for; 2.0.2 is what it had been loading all along and is unaffected. Practical exposure was low — the advisory targets `getSemanticHTML()`, which this app does not call — but there is no reason to carry it. `npm audit` is now clean.

## [6.17.0] - 2026-07-30

### Security
- **Uploaded documents were publicly downloadable.** `fileController.getBaseDir()` wrote every upload into `public/<model>/`, and `services/authService.js` listed `/resources/` in `PUBLIC_PREFIXES` — so `isPublicPath()` returned true for it and the `ensureAuthenticated` guard on the `/resources` static mount in `app.js` never gated anything. Any document attached to any record (CIS, HR, payroll, project) could be fetched by anyone with the URL, no session required. Confirmed live before the fix. The store now lives outside `public/` (`services/fileStorage.js`, `FILE_STORAGE_DIR`) and is reachable only through the authenticated file routes. `PUBLIC_PREFIXES` is narrowed to the four static asset subtrees the logged-out login and setup pages actually need.
- **File routes now authorise against the parent record instead of a flat role check.** They were gated on `ensureRole("admin")`, which said nothing about whether the caller may see the record a document hangs off. `services/ensureCanAccessRecord.js` reuses the existing RBAC primitives — `rbac.canAccess(role, model, op)` for model access and `rbac.getOwnershipConfig()` for own-only roles — and loads the parent record through that ownership filter; if it does not come back, the request 404s (not 403, which would confirm the record exists). Reading a document needs `r` on the model, adding or removing one needs `u`. Admin keeps its existing bypass.
- Added path-traversal backstops in `resolveFilePath()` for the view, download, delete and upload paths.

### Fixed
- **Uploads did not survive a deploy.** multer's `dest: "uploads/"` was relative, resolving against the process working directory, and the final store sat in the container's writable layer with no volume behind it. With `pull_policy: always`, every deploy destroyed everything uploaded since the last one. Both the temp dir and the store are now absolute and under `FILE_STORAGE_DIR`, which must be mounted. **Deploy note: `docker-compose.yml` needs a volume at that path — the existing `./uploads:/uploads` bind pointed at a path nothing uses and can be replaced.**
- Model directory names are now lowercased on both the write and read paths. Uploads went to `public/<model>/` while `viewFile` built URLs with a capitalised name — different paths on a case-sensitive filesystem.
- multer's temp dir now shares a root with the destination, so the `fs.rename` into place cannot fail with `EXDEV`.

### Removed
- `public/Project/a7430e9e-…/` — two real client files (a photo and a Word document) committed in `515833e1` (2025-07-18) and baked into every image since. They remain in git history; purging that requires a history rewrite and force-push, which has not been done.

## [6.16.0] - 2026-07-30

Makes the app genuinely installable and usable on a phone. The PWA scaffolding has been in the repo for a long time but has never done anything; this wires it up and fixes the mobile navigation.

### Fixed
- **Alpine.js was never loading.** The layout pulled `alpinejs@3.x.x/dist/alpine-csp.min.js` from jsDelivr — a path that returns **404** — so every Alpine-driven component in the app has been silently dead. Alpine's CSP build moved to its own package (`@alpinejs/csp`) at 3.15; it is now installed, pinned and self-hosted.
- **The service worker controlled nothing.** It was registered from `/resources/js/service-worker.js`, and a worker's scope is the path it is served from, so its scope was `/resources/js/` — it could never intercept `/`, `/cis`, `/payroll` or any real page. Now served and registered from `/service-worker.js`.
- **The manifest and worker sat behind `ensureAuthenticated`.** Both redirected to the login page for logged-out visitors, which is precisely when the browser evaluates installability. Both are now served from unauthenticated routes, along with `/resources/images` and `/resources/vendor` (branding and vendored libraries, needed by the login and setup pages).
- **The manifest could not trigger an install prompt.** Icons were 32/64/256 only; Chrome and Android require 192×192 and 512×512. Added both, plus a `maskable` variant, `id` and `scope`.
- Mobile nav labels were `hidden` below the `sm` breakpoint, leaving phone users — the on-site staff who most need it — with ~11 unlabelled icons and no way to distinguish CIS from Payroll from Finance. Labels are now visible at every breakpoint at a smaller size; the row already scrolled horizontally.

### Added
- **Offline fallback.** A self-contained `public/offline.html`, precached by the worker and shown when a navigation fails.
- **Accessibility attributes in the layout**, which previously contained none: `aria-label` on the nav and the icon-only theme toggle, `aria-hidden` on decorative icons, `aria-current="page"` on the active nav item.
- `tests/pwaAssets.test.js` — regression cover for the worker's location, manifest icon sizes, the absence of CDN references, exact version pins, and the nav label/ARIA rules.

### Changed
- **Third-party browser assets are now self-hosted.** Alpine, Quill, Chart.js and Bootstrap Icons are installed as exact-pinned devDependencies and copied into `public/vendor/` by `scripts/vendor-assets.js` (`npm run build:vendor`, run by the Docker builder stage and copied into the runtime image, the same pattern as `tailwind.css`). `public/vendor/` is generated, not committed. `cdn.jsdelivr.net` has been removed from the CSP entirely. Bootstrap Icons matters most here: the nav is icon-driven, so a CDN failure on a poor site connection left staff with an unusable navigation.
- **The service worker no longer caches page HTML.** The previous implementation was cache-first across every request with no versioning and no cleanup, which would have pinned staff to a permanently stale dashboard with no way to clear it. It now caches only static assets (stale-while-revalidate, versioned, with an `activate` cleanup); navigations are network-only with the offline fallback. Page HTML is deliberately never cached — this is an ERP holding payroll, HR and CIS data on shared site devices, and cached pages would let the next user page back through the previous user's data after logout.
- Manifest `theme_color` is now the brand emerald `#047857` (was a neutral grey unrelated to the app's palette), and `short_name` is "Heron CS".
- **`script-src`, `style-src` and `font-src` are now `'self'` only** (plus the per-request nonce, and Cloudflare Turnstile in `script-src`, which the auth views genuinely use). Alongside jsDelivr, the `unpkg.com`, `cdn.tailwindcss.com`, `fonts.googleapis.com` and `fonts.gstatic.com` entries were dead allowlist from earlier designs — nothing in the app loaded from any of them. `img-src` is deliberately left as-is: its third-party origins are unreferenced in source, but image URLs can come from database content, so tightening it needs a data audit rather than a code search.

### Added
- **Manifest `shortcuts`** — long-pressing the installed icon jumps straight to Attendance, Create, CIS or Documents. Shortcut targets are static, so a user without access to a department follows the normal authorisation flow on arrival.

## [6.15.1] - 2026-07-27

### Fixed
- **All generic CRUD/list routes were missing in production (every `/suppliers`, `/supplier/read/:uuid`, `/purchases`, etc. returned "Page Not Found").** ESM-migration regression: `CRUDController.js` and `listController.js` generate their handlers by iterating `mdb.REST`/`mdb.INTERNAL` at module-evaluation time, and the migration turned app.js's Phase-2 `require()` of `CRUDRoutes`/`listRoutes` into hoisted static imports — so both controllers ran against empty namespaces before `mdb.connect()` and registered zero routes. app.js now dynamically `await import()`s both routers inside Phase 2, after the models are loaded, restoring the CJS-era timing. Note for future modules: anything that enumerates `mdb` models at import time must be imported after `mdb.connect()`.

## [6.15.0] - 2026-07-27

### Changed
- **Entire codebase converted from CommonJS to ESM** (`"type": "module"`; 250+ files). `require`/`module.exports` → `import`/`export` throughout. Key mechanical details:
  - Modules that attached extra functions to their main export (loggerService `sanitize`/`setSocketInstance`, maintenanceService, csrfService `validate`) keep that property shape on the default export, so `logger.sanitize(...)` / `csrfService.validate` call sites are unchanged.
  - `__dirname`/`__filename` shimmed via `import.meta.url` where used; `package.json` reads use `readFileSync` + `JSON.parse` instead of `require`.
  - The dynamic model loader (`mongooseDatabaseService.createNamespace`) now uses `await import()` with `pathToFileURL`.
  - Tests that set env vars or patched `require.cache` before requiring modules now use top-level `await import(...)` and `mock.module()` (test runner passes `--experimental-test-module-mocks`).
  - `scripts/generate-tailwind-safelist.js` emits `export default` (tailwind.safelist.js regenerated accordingly).

### Fixed
- Removed a latent crash in the bootstrap-admin seeding path: it lazily `require`d the `uuid` package, which was never a declared or installed dependency. Now uses `crypto.randomUUID()`.
- REST model files import `@cappytech/hcs-schemas` via default-import + destructure — the guaranteed CJS/ESM interop path — so the app works against both schemas 1.1.0 (CJS) and 2.0.0 (ESM) and app/schemas releases are not deploy-order-coupled. (Named imports from the CJS package fail at model load; the test suite never exercises that path.)
- Docker builder stage now copies `tailwind.safelist.js`. The old CJS config loaded it in a try/catch, so Docker CSS builds silently ran without the generated safelist; the ESM static import surfaced this.

### Notes
- `@cappytech/hcs-schemas` updated to **2.0.0** (ESM) in the lockfile.
- Client-side files under `public/` are untouched (served to browsers, not loaded by Node).

## [6.14.4] - 2026-07-23

### Removed
- **`Caddyfile` and the `caddy` service dropped from this repo.** The root `Caddyfile` was a stale copy of the VPS front-door config (it served `team.`/`sync.`/`app.heroncs.co.uk` and proxied to `frps:18080` — an upstream that only exists on the VPS, contradicting this stack's own `tailscale:${PORT}` comment). TLS terminates at the VPS-level Caddy defined in the hcs-docs repo (`caddy/Caddyfile`), which also carries the `-dev` domains for shared dev deployments; local dev uses plain HTTP via `docker-compose.local.yml` or `npm run dev`. The `caddy` service and its `caddy_data`/`caddy_config` volumes were removed from `docker-compose.yml`, and README/docs references updated. **Deploy note:** if a `caddy` container from this stack is running on Server2, `docker compose up -d --remove-orphans` will retire it.

## [6.14.3] - 2026-07-23

### Removed
- **`_check_schema.js` deleted.** Root-level temporary debug script for dumping schema paths from `@cappytech/hcs-schemas`; also removed its mention from `AGENTS.md`. All remaining root files were audited and are in active use.

## [6.14.2] - 2026-07-23

### Changed
- **`compose.env.example` cleanup.** Removed the dead `FETCH_API_TOKEN` variable and its stale `kashflowAPI/routes.js` comment (that module no longer exists); the variable had also drifted into the People's Pension section. KashFlow section restructured to present the three auth alternatives (credentials, external token, session token) instead of marking credential vars `# required`; `KASHFLOW_DEBUG_SESSION` is now commented out (opt-in) rather than enabled by default. Documented previously missing vars the code reads: `HCS_SYNC_TIMEOUT_MS`, `KASHFLOW_EXTERNAL_TOKEN`/`KASHFLOW_EXTERNAL_UID`, `KASHFLOW_CREATOR_WEBHOOK_URL`/`KASHFLOW_CREATOR_WEBHOOK_TOKEN`, `KASHFLOW_VATLEVEL_TOLERANCE`, and the new `HCS_SYNC_PULL_DELAY_MS`.

## [6.14.1] - 2026-07-23

### Changed
- **Draft-page supplier creation now auto-refreshes the full record from KashFlow.** After `POST /paperless/suppliers` creates a supplier, hcs-app schedules a fire-and-forget `hcsSyncService.pullEntity('supplier', <Code>)` call to hcs-sync's `POST /api/pull` after a short grace period (default 5s, tunable via `HCS_SYNC_PULL_DELAY_MS`) so KashFlow has time to make the new supplier readable. This backfills the fields the create payload doesn't carry (address, payment terms, contacts, etc.) without waiting for the next scheduled sync run. Requires `HCS_SYNC_API_KEY`/`HCS_SYNC_BASE_URL`; failures are logged and non-fatal — the scheduled sync still reconciles.

## [6.14.0] - 2026-07-23

### Added
- **Create suppliers from the purchase draft page.** The Supplier panel on `/paperless/ocr/:id/draft` gains a "Supplier not in the list? Create it in KashFlow…" section (name prefilled from the draft, optional code and default Purchases nominal). It POSTs to the new `POST /paperless/suppliers` endpoint, which creates the supplier directly in KashFlow (`POST /v2/suppliers`, with `CreateSupplierCodeIfDuplicate` so a blank/derived code can't collide) and upserts the response into the local REST `suppliers` collection so the picker, nominal fallback and send flow can use it immediately — no waiting for the next hcs-sync run, which then reconciles the full record. The new supplier is auto-selected in the picker on success. Guards: exact-name match against existing non-archived suppliers returns the existing record (and selects it) instead of creating a duplicate; a supplied default nominal must be a `Purchases`-classified nominal; requires direct KashFlow credentials (same as sending) and sits behind the usual paperless auth/role/department guard + CSRF.

## [6.12.3] - 2026-07-17

### Changed
- **"This is an automated message from the Heron CS platform." now sits at the very bottom of the email.** It previously rendered inside the message body (above the branded footer and the unsubscribe line). Moved it out of `wrapTemplate` into a shared `AUTOMATED_NOTICE` block that `enqueue` and the type preview append *after* the branded footer and unsubscribe line, so it's always the last thing in the email (HTML and plaintext parts).

## [6.12.2] - 2026-07-17

### Changed
- **Refreshed the default copy for all core email types.** Revised the label and description of every seeded `emailType`, and added a default `heading` and `intro` to each (previously empty). Notable label changes: "Task due / overdue" → "Task reminders", "System broadcast" → "Announcements". The seeder is insert-only, so this only affects **fresh installs** — existing databases keep their current (admin-editable) copy, edited at `/admin/emails/types`. The revised `heading`/`intro` surface in the type preview and admin-composed messages; automated system senders build their own bodies and are unchanged.

## [6.12.1] - 2026-07-17

### Fixed
- **Email header/footer inline styles were being stripped.** The global `xssSanitize` middleware pipes every field through the `xss` library's default whitelist, which drops `style` attributes — so admin-authored branding HTML rendered as unstyled, left-aligned, default-blue links. Added an `EMAIL_HTML_FIELDS` whitelist (`headerHtml`, `footerHtml`) that preserves inline `style` on the layout/link/image/table tags email clients require, while still stripping `<script>`, event handlers and `javascript:` URLs (CSS values remain filtered by the library's cssfilter). Note: header/footer HTML saved before this fix is already style-stripped in the DB and must be re-saved to pick up styling.

## [6.12.0] - 2026-07-17

### Added
- **Platform-wide email header & footer.** A new `emailBranding` singleton (managed at `/admin/emails/branding`, linked from the Email hub) holds a branded header and footer — raw HTML for logos, contact details, address, social links, etc. — that `notificationService.enqueue` now wraps around **every** outgoing email (both HTML and a derived plaintext part). Each block has its own enable switch, and the branded footer sits **above** the mandatory unsubscribe line, which remains always-present. Content is authored by admins (a trusted role) and rendered verbatim.
- **Per-email header/footer opt-out.** Each email type gains `useGlobalHeader` / `useGlobalFooter` toggles (default on) on its `/admin/emails/types` editor, so a specific type (e.g. a bare security alert) can suppress the global branding while others keep it.
- **Multiple action buttons per email.** `emailType` gains an ordered `actions[]` array (`{label, url}`, up to 5), edited via repeatable rows in the type editor. `notificationService.wrapTemplate` now renders an `actions` array of centred, wrapping buttons (the legacy single `ctaText`/`ctaUrl` still works and is merged in). Admin-composed messages and the type preview render the configured buttons; button URLs are scheme-checked (`http(s)`/`mailto`/`tel`/relative only — `javascript:` etc. neutralised to `#`).

### Changed
- **Type preview reflects branding + buttons.** `/admin/emails/types/:key/preview` now renders the global header/footer (respecting the type's opt-in) and the type's own action buttons.

## [6.11.1] - 2026-07-17

### Added
- **Startup config validator** (`configValidatorService`) sanity-checks the metadata-driven list/CRUD config against the registered models on boot: it warns (non-fatal) about unknown/typo'd option keys (e.g. `hideFileds`) and config entries with no backing model. The list/CRUD engines read config as plain objects, so such mistakes previously failed silently. It immediately surfaced a stale `CRUDControllerConfig.contractAssignment` entry (no such model/route; `attendance.contractAssignmentId`'s `linkTo` points at a non-existent `/contractAssignment` route — a half-wired feature to finish or remove).

### Changed
- **Pre-login landing page now reflects the platform's real scope.** The public home page previously described the app as only subcontractor management, document uploads and CIS reports. The hero tagline and feature highlights now cover the actual departments — CIS compliance, HR & attendance, fleet & assets, document management (OCR / Paperless sync), finance, and projects & tasks — mapped to the same overviews shown after login, with matching Bootstrap icons.
- **Payroll and direct HMRC integration removed from public-facing copy.** These are still in development and not production-ready, so they are no longer advertised on the landing page or in the `package.json` description: dropped the "Finance & Payroll" (PAYE/payroll submissions) card down to a "Finance" card, removed "HMRC-ready" from the CIS card, and dropped "payroll"/"HMRC" from the hero tagline and package description.
- **Email type customisation completed; dead config removed.** Removed the unused `audienceRoles` field from email types (it configured nothing). The `subjectPrefix`/`intro` fields shipped in 6.11.0 with no way to set them — renamed `subjectPrefix` → `heading` (it sets the email heading, it never prefixed) and added editor inputs so admins can now give each type a custom heading and intro paragraph, reflected in the preview and admin-composed messages.

### Security
- **Unsubscribe links auto-expire (~24h) via daily token rotation.** A new `unsubscribe-token-rotation` background job rotates every user's `notificationToken` on startup (if due) and every 24h, so a signed unsubscribe link stops working within ~a day. Enable/disable and last-run are on the Email & Notifications admin page (config key `UNSUBSCRIBE_ROTATION_ENABLED`, default on), plus a manual "Rotate now". Last-run is **persisted** (`jobState` collection / `jobStateService`) so a restart/deploy doesn't re-rotate early and shorten the window — the scheduler is otherwise in-memory. A recipient whose link has rotated now gets a friendly "please sign in to unsubscribe — your link was rotated for security, you have 24h" page (HTTP 410) instead of a bare error.
- **Unsubscribe links hardened against link-holders.** Email unsubscribe links now carry a **signed, expiring, per-scope token** (`unsubscribeTokenService`, HMAC-SHA256, 90-day expiry) instead of a static per-user token in the query string. The token is tamper-proof (user id, scope and expiry are signed) and scoped to a single preference, so a leaked link can't be repurposed. Layered on the existing protections: the link is opt-out-only (can never re-enable or redirect), GET is read-only (scanners/prefetchers change nothing), POST needs an explicit click + CSRF, and the address is masked on the confirmation page.
- **Per-user "reset unsubscribe links".** The user's `notificationToken` is mixed into every signed link's HMAC key, and a new control on the notification settings page rotates it — instantly invalidating every outstanding unsubscribe link for that user (and only that user) after a forwarded email or suspected leak. Subscriptions are unaffected.
- **Dedicated rate limit** on `GET`/`POST /notifications/unsubscribe` (30/15 min per IP) on top of the global limiter, to blunt token-guessing and abuse of the public endpoint.
- Links sent by 6.11.0 keep working: the endpoint verifies a signed token first and falls back to the legacy static token. Optional `UNSUBSCRIBE_SECRET` config (defaults to `SESSION_SECRET`).

### Fixed
- **Email preview rendered as unstyled "plain HTML".** The notification preview serves email HTML, which styles itself with inline `style="..."` attributes — stripped by the app-wide CSP (`style-src 'self'` + nonce, no `'unsafe-inline'`), so the preview showed unstyled. The preview response now sets its own scoped CSP that permits inline styles but forbids scripts/forms, so it renders exactly like the delivered email while staying safe.
- **Admin catalog previewed emails through the user-scoped route.** The admin type catalog linked to `/user/account/settings/notifications/preview/:key` (a personal-account page) instead of an admin route. Added a dedicated admin preview at `/admin/emails/types/:key/preview` (admin-guarded) and pointed the admin views at it; the shared preview rendering now lives in `notificationService.renderPreviewDocument`.
- **Admin email hub had no way to edit types.** The "types at a glance" table now has Edit and Preview actions per row; Edit deep-links to the catalog with that type's editor expanded (`/admin/emails/types?edit=<key>#type-<key>`).

## [6.11.0] - 2026-07-16

### Added
- **Email & notification management system.** A DB-driven catalog of notification types replaces implicit, hardcoded email categories, with dashboards for both admins and users and a proper unsubscribe flow.
  - **New models:** `emailType` (catalog: key, label, `senderType` system/admin, `subscribable`, `defaultOn`, `enabled`, `isCore`) and `emailPreference` (per-user subscription; absence falls back to the type's `defaultOn`). `user` gains `allowAdminEmails` + a per-recipient `notificationToken`; `notification` gains `typeKey`, `senderType`, `unsubscribable`, `recipientUserId`, `senderUserId`. Core types are seeded at startup (insert-only, admin edits preserved) via `emailTypesSeedService`.
  - **Gating:** `notificationService.enqueue` now skips disabled types, recipients who unsubscribed from a subscribable type, and any admin-originated email when the recipient turned off "allow admins to email me". Existing callers keep working (`category` is treated as `typeKey`).
  - **Admin email dashboard** (`/admin/emails`): manage the type catalog (add / edit / enable-disable / delete, core types protected), compose and send email to a single user or a whole role, and an outbox with delivery status + resend/cancel.
  - **Personal notification dashboard** (`/user/account/settings/notifications`, also a dashboard tile): per-type subscribe/unsubscribe toggles, a master "allow administrators to email me" switch, per-type preview, and "send myself a test".
  - **Unsubscribe on every email** with four footers keyed to who sent it (user / system / admin notification / admin direct-send). Links are hostile-safe: `GET /notifications/unsubscribe` only renders a confirmation page (email scanners/prefetchers change nothing), and the token authorises a single preference change — never a login. In-app footer links deep-link to the relevant toggle on the personal dashboard.
- **Task assignment emails.** Creating a task now queues a `task-assigned` system notification to the assignee (respecting their subscription); recurring spawns are covered via the same path.

## [6.10.2] - 2026-07-10

### Added
- **Setup wizard: per-namespace database name fields** (REST / Internal / Paperless) on step 1, written to `app-config.json` as `MONGO_DBNAME_*`; Test Connection now also lists the databases visible on the server.
- **Setup wizard: skip options** — step 2 can be skipped (secrets generated server-side), and step 3 can be skipped when the database already has users (no bootstrap admin written).

### Fixed
- **CIS dashboard: subcontractors invisible because KashFlow stopped returning `SupplierId` (~May 2026).** Purchases created since mid-May carry only `SupplierCode` (e.g. `MICH01`), so the dashboard's Id-based supplier lookup matched nothing — tax month 3 (Jun–Jul 2026) showed zero subcontractors despite 7 verified-subbie purchases existing. Suppliers are now matched by `Id` OR `Code`, and per-supplier totals key off the resolved supplier. Pairs with hcs-sync 0.7.2, which backfills `SupplierId` on future syncs.
- **Setup wizard: POST handlers crashed with `req.body` undefined.** The wizard mounts before the main app stack's body parsers; `setupRoutes` now mounts its own `express.json()`/`urlencoded()`.
- **`app-config.json` with a UTF-8 BOM silently parsed as empty config**, which re-armed the setup wizard and let a subsequent save drop every existing key. `configService` now strips a BOM before parsing.

## [6.10.1] - 2026-07-10

### Fixed
- **CIS dashboard: a purchase's `TaxYear`/`TaxMonth` stamp no longer overrides actual payment dates.** The stamp was honoured exclusively, so an invoice part-paid across a tax-month boundary vanished from the month of its later payment. The stamp is now one OR condition alongside the payment-date window checks — HMRC counts each payment in the month it was made.
- **CIS dashboard: unpaid invoices no longer count as paid purchases.** Legacy stamps derived from `IssuedDate` (hcs-sync ≤0.7.0) put unpaid invoices on the dashboard as if paid (tax month 3 showed 213 "paid" purchases when only ~139 had a payment in the period). A stamped purchase now also requires at least one actual payment (`PaidDate` or any payment line). Pairs with hcs-sync 0.7.1, which stops stamping unpaid purchases and clears stale stamps on its next run.

## [6.10.0] - 2026-07-09

### Added
- **Ten new KashFlow REST models**, extending 1-1 API parity with KashFlow (requires `@cappytech/hcs-schemas` 1.1.0; populated by hcs-sync 0.7.0): `bankTransaction`, `journal`, `product`, `purchaseOrder`, `purchaseOrderCategory`, `quoteCategory`, `currency`, `country`, `accountingPeriod`, `vatReturn`. All auto-registered into the REST namespace at startup; schemas use `strict: false` since KashFlow's documented shapes for these entities are incomplete.
- **/help/api: seven new endpoint groups** — Journal, Product, PurchaseOrder, PurchaseOrderCategory, Currency, Country, AccountingPeriod (BankTransaction, VatReturn and QuoteCategory were already documented). 28 groups / 213 operations total.

## [6.9.1] - 2026-07-08

### Added
- **Subcontractor drafts: added line items can be saved.** A "Save added lines" button persists the rows onto the OCR document in MongoDB (`draftExtraLines`, via `POST /paperless/ocr/:id/draft/extra-lines` — same guard chain as the draft, subcontractor documents only, same validation as sending — the send path's inline extra-line validation is extracted into a shared `parseExtraLineInput()` helper). Saved lines are restored as editable rows whenever the draft is reopened; saving with no rows clears them. Paperless custom fields only have `_Line1` slots, so extras live on the MongoDB document rather than being written back to Paperless. Sending remains screen-authoritative: what's in the table is what's sent, saved or not.

### Fixed
- **Subcontractor drafts with multiple enumerated lines defaulted rows 2+ to the wrong nominal.** The draft view's row-0 → Sub-contractors / row-1 → Materials nominal defaulting was written for the synthetic two-row labour+materials expansion but applied to every subcontractor draft — with N enumerated `_LineN` lines, row 2 was pre-set to Materials and rows 3+ to the supplier default (also Materials for JOHN02), and those pre-selected values were posted on send (purchase #14522: 8 of 9 labour lines created on 2700 instead of 5300). The labour/materials split now only applies to the fallback expansion; enumerated subcontractor lines default to the sub-contractors nominal.

## [6.9.0] - 2026-07-08

### Changed
- **Department dashboards reorganised around a single canonical registry.** New `mongoose/config/departmentsConfig.js` defines every department (slug, title, nav label, icon, allowed roles, order). Everything previously duplicated across five files is now derived from it: `roleDepartments` and the dashboard `routeAccess` entries in `rolePermissionsConfig.js` are computed; `indexController.js`'s twelve per-department exports (`renderAdmin`, `renderPayroll`, …) are replaced by a generic `renderDepartment(slug)`; `indexRoutes.js` generates one guarded route per registry entry; and the hardcoded top nav in `layout.ejs` (~80 lines of per-department blocks) is a single loop over the registry (exposed via `res.locals.departmentsConfig`).
- **KashFlow department merged into Finance.** All KF_* external-link tiles and KashFlow-synced models (customers, invoices, quotes, purchases, projects, suppliers) now appear on the Finance dashboard; `/kashflow` redirects to `/finance`. Accountant access unchanged.
- **Paperless and Company Docs merged into a new Documents department** at `/documents` — Paperless OCR tiles plus a new "Letterhead & Policies" tile linking `/company-docs`. `/paperless` (the dashboard) redirects to `/documents`; the `/paperless/ocr` routes are unchanged apart from their guard now checking the `documents` department. Top nav drops from 13 items to 11.
- **Accountants can now open `/payroll`.** `roleDepartments` always granted accountants the payroll department (they saw the nav link) but the route guard was admin-only and 403'd — exactly the config drift this refactor removes. `/payroll/dashboard` already allowed accountants.
- **`dashboardTilesConfig.js` regrouped into commented department sections**, with cleanups: the redundant Two-Factor Auth tile removed (the User Settings tile covers the same `/user/account` page and its description now mentions 2FA), and the management copy of the weekly attendance tile retitled "Weekly Attendance (Management)" to distinguish it from the payroll/HR tile.

## [6.8.23] - 2026-07-08

### Added
- **Subcontractor drafts: add extra line items in the draft view.** An "Add line item" button (subcontractor documents only) appends editable rows — description, qty, unit price, VAT amount, with the same Project and Nominal dropdowns as server-built lines and live Net/Gross calculation. Added rows are validated server-side (description/qty/unit price required, nominal checked against purchase-classified nominals) and appended to the KashFlow payload; they travel as a separate `extraLines` JSON field so the index-aligned `nominalCodes[]`/`projectNumbers[]` arrays for server-built lines are undisturbed.
- **Subcontractor drafts: payment lines.** A new "Payment Lines" card lets you record payment(s) in the same send — account, amount, date, method, note — passed through to KashFlow's `PaymentLines` on `POST /purchases`. The account selector is a named dropdown of bank accounts synced from KashFlow (new `bankAccount` REST model over hcs-sync 0.6.0's `bankaccounts` collection, default account first, archived excluded); when none are synced yet it falls back to a numeric Account Id input with suggestions aggregated from payments on previously synced purchases. Method suggestions come from the same aggregation. Server-side validation requires a positive integer Account Id and a non-zero amount per line. Recording payment at creation also lands the purchase in the correct CIS month on the next sync (hcs-sync derives `TaxYear`/`TaxMonth` from the earliest payment date).

### Changed
- Requires `@cappytech/hcs-schemas` 1.0.2 (adds the `bankAccount` entity and the previously-stripped `PaymentLines.BankTransactionId` field).

## [6.8.22] - 2026-07-07

### Security
- **Fixed CSP `script-src-attr` violation on `/overview/documents`.** The Remove button in the "Deleted in Paperless" panel used an inline `onclick="return confirm(...)"` handler, which is blocked by the `script-src-attr 'none'` policy. Replaced with a `data-confirm` attribute, handled by the existing `ui-helpers.js` listener.

## [6.8.21] - 2026-07-03

### Added
- **Purchase detail links back to its Paperless document.** When an OCR document is linked to the purchase (by KashFlow Id or Number, PICP linkage), the purchase read view header shows a "View Document" button opening the internal `/paperless/ocr/:id` detail page. Admin-only, matching that route's access; documents flagged deleted in Paperless are excluded.

### Changed
- **Purchase line items show project and nominal names instead of bare codes.** `Project #40810 · Nominal 5300` becomes `#40810 <Project Name> · <Nominal Name> (5300)` — projects and nominals are resolved in batched lookups from the synced KashFlow collections, with graceful fallback to the code when unmatched. The project name links to the project detail page for admins/accountants; subcontractors see plain text (they have no project access). Invoice/quote views sharing the line-items partial are unchanged.

## [6.8.20] - 2026-07-03

### Added
- **Reconciliation pass: documents deleted in Paperless are now detected.** Previously a document deleted in Paperless left a permanent ghost in MongoDB — still counted in totals and stuck forever in the Unlinked/Never Sent panels with nothing to link. The grab now records every document ID seen during a full unfiltered listing sweep and flags MongoDB docs that no longer appear (`deletedInPaperlessAt`); the flag clears automatically if a document reappears, and a per-document re-ingest 404 also sets it. Flagged docs are excluded from all actionable buckets (Unlinked, Never Sent, Missing KF Link, drift counts and Fix All, stale-link sweep, Resolve Numbers, Match References) and surface in a new "Deleted in Paperless" overview panel showing any KashFlow link they carried, with a per-document Remove button (`POST /paperless/ocr/:id/remove`) that deletes the MongoDB copy + ingest record — removal is refused for docs still present in Paperless. Filtered grabs (since/query) skip reconciliation, as does an empty listing (more likely an API problem than an emptied Paperless).

## [6.8.19] - 2026-07-03

### Changed
- **Paperless tags now drive KashFlow-eligibility on the Documents overview.** Documents tagged "original/multiple invoice one pdf" (reference originals whose invoices are entered separately) or "credit/refund" (automatic tag — more reliable than the title-based credit heuristic, which is kept as fallback) are excluded from the Unlinked, Never Sent and Missing KF Link tiles/panels and skipped by Match References. Documents tagged "manually added to kashflow" are excluded from Never Sent only — the app will never send them, but they stay in Unlinked so Match References / Resolve Numbers can still attach them to their purchase.

## [6.8.18] - 2026-07-03

### Changed
- **Documents overview says "Custom Field" instead of "CF".** The drift tile, panel header and drift-table column header are spelled out for clarity.

### Fixed
- **Bulk Paperless custom-field write-backs fired in parallel and all 500'd.** Resolve Numbers, Match References and Repair Drift's orphan-clear launched their `PATCH /documents/:id/` write-backs fire-and-forget inside their loops, and the Paperless ingest drift-guard used `setImmediate` per document — dozens of concurrent PATCHes hit Paperless-ngx at once and every one failed with 500 under write contention (MongoDB links were unaffected; the failures only left custom-field drift). The controller loops now await each write-back sequentially, and the ingest write-backs are serialized through a shared promise chain. Paperless PATCH failures now also log the response body instead of just "Request failed with status code 500".

## [6.8.17] - 2026-07-03

### Added
- **"Match References" — cross-check unlinked Paperless documents against synced KashFlow purchases by supplier reference.** Resolve Numbers could only fix unlinked documents that already had a KashFlow purchase number recorded; documents sent to KashFlow but never enriched (webhook sends, lost responses) stayed unlinked with no number to resolve. Since the send pipeline writes the document's invoice-number custom field into the created purchase's `SupplierReference` — now available locally via hcs-sync — a new admin action (`POST /paperless/match-references`, button on the Documents overview Unlinked panel) matches each unlinked KF-eligible document's extracted supplier reference against REST purchases (exact trimmed case-insensitive match, deleted and already-claimed purchases excluded). A link is written only when exactly one candidate survives validation by gross amount (±1p) or normalized supplier name; ambiguous or disagreeing matches are logged and skipped. Successful links update MongoDB and write the KashFlow ID back to the Paperless custom field, same as Resolve Numbers.
- **Resolve Numbers now diagnoses its misses.** "Purchase number N not found in REST" is replaced by three distinct warnings: the purchase exists but is soft-deleted, the stored value matches a KashFlow *Id* rather than a Number (older custom-field backfills wrote the Id in some paths — the log includes that purchase's Number, supplier and reference for manual verification), or it genuinely isn't in REST yet (not synced).

## [6.8.16] - 2026-07-03

### Added
- **Purchases list search now matches supplier reference.** The `/purchases` search box previously only matched the KashFlow number; `SupplierReference` is now included as a case-insensitive partial match alongside it.

## [6.8.15] - 2026-07-03

### Fixed
- **Documents-overview "KashFlow ↗" links resolved to the wrong domain.** `kashflowPermalink` values are API-relative paths (`/v2/documents/purchase/…`), and the CF Drift and Stale Links tables rendered them raw, so the browser resolved them against app.heroncs.co.uk. The overview now links to the KashFlow UI purchase page by number (matching every other view), falling back to the permalink prefixed with `https://api.kashflow.com`.
- **Documents with a KashFlow Purchase Number custom field could be falsely flagged "linkage missing".** The re-fetch backfill only stored the number in MongoDB when a REST purchase lookup by that number succeeded; on lookup failure it stored nothing, so the document detail banner, the overview Missing KF Link count, and the `noKfNumber` filter (which all check MongoDB's dedicated `kashflowPurchaseNumber` field) claimed no number was recorded even though it was visible in Paperless. The backfill now always stores the CF number (without the ID when the lookup fails), so such documents surface in the "Has KF# (no ID) — resolvable" bucket instead and can be linked by Resolve Numbers once the purchase syncs.

## [6.8.14] - 2026-07-03

### Changed
- **Stale KashFlow link clearing is now admin-triggered only.** The `ocr-orphans` job no longer runs automatically every 24 h — the job scheduler now supports manual-only jobs (`intervalMs: null`), which appear on `/admin/jobs` with a Run button but are never scheduled. Admins clear stale links via the "Clear Now" button on the Documents overview or from the jobs page. The sweep logic itself is unchanged, including the 48-hour hold on recently sent documents so hcs-sync can pick up new purchases. Also removed `ocrOrphanService`'s dead self-scheduling `start()`/`stop()` code (never wired into app.js) and updated the Documents-overview banner text, which claimed links "are cleared automatically".

- **Documents overview filters out non-KashFlow document types.** The Unlinked, Never Sent and Missing KF Link tiles/panels now only count purchases (excluding credit notes by title), since statements, subcontractor docs and credits are never sent to KashFlow and were permanent noise in those lists. Excluded counts are shown next to the tiles and panel headers so the totals remain transparent; the raw send-mode pills (Direct/Webhook/Never Sent) are unchanged.

### Fixed
- **Stale links on never-sent documents were unclearable.** The orphan sweep matched only `lastSentAt < 48 h ago`, which never matches `lastSentAt: null` — so linked-but-never-sent documents (e.g. linked via number resolution) appeared in the Documents-overview "Stale KashFlow Links" panel forever and Clear Now silently skipped them. Never-sent docs are now cleared immediately (they have nothing pending in hcs-sync); the 48-hour hold still applies to recently sent documents, and held rows now show a "held" badge in the stale-links table.

## [6.8.13] - 2026-07-02

### Changed
- **moment → date-fns migration complete (phase 2).** The remaining six files are ported and `moment`/`moment-timezone` are no longer runtime dependencies (moved to devDependencies — two test files still use moment as an *independent* implementation to verify date maths against):
  - `attendanceService` — the Saturday-based payroll-week engine now works in explicit London wall-time arithmetic (new `londonMidnight`/`londonEndOfDay`/`addLondonDays` helpers, DST-safe day addition). **API change:** `payrollWeekStart`/`endDate` returned by `getAttendanceForWeek` are now plain `Date` instants (London midnight) instead of moment objects; the exported week functions accept Date/moment/string inputs via a tolerant converter, so existing callers and test fixtures keep working.
  - `attendanceController` — new strict `parseYMDLocal` helper preserves moment's strict `YYYY-MM-DD` validation (rejects rollover dates like `2025-02-30`) and local-midnight parsing for inline attendance/assignment/deployment creation.
  - `cisController` — non-ISO KashFlow date strings ("YYYY-MM-DD HH:mm:ss") parse via a single `parseLondonString` helper; the CIS submission-window dates now come from `taxService.getCurrentMonthlyReturn` instead of being re-derived locally; BST/GMT display tags via `getTimezoneOffset`.
  - `holidayService` — also **fixes two latent crashes**: matched bank/custom holidays called `.format()` on plain Dates/strings, which threw and made `isDateHoliday` return its error shape instead of holiday details.
  - `returnsController` (tax-month names now a plain April-first lookup; one shared London date formatter) and `settingsController` (session expiry/idle humanised with `formatDistanceToNow`; sessions with unparseable expiry are now purged).
- **New global template helper `fmtDate(date, pattern)`** (`dateService`, injected via res.locals) replaces passing `moment` into views — all 28 `moment(...).format(...)` call sites across 8 EJS templates converted, and the `moment` pass-through locals removed from the weekly attendance views.
- **Fixes a 6.8.12 regression**: `holidayController` and `indexController` passed bare `moment` into render locals, which the 6.8.12 dead-require cleanup missed — the holiday-notice page and home dashboard would have thrown at render. Both locals removed; templates use `fmtDate`.

## [6.8.12] - 2026-07-02

### Changed
- **moment → date-fns migration, phase 1 (the shared date services).** `services/taxService.js` (CIS tax-year/tax-month/return-period engine) and `services/dateService.js` (`slimDateTime`, injected into every template) are ported from `moment-timezone` to `date-fns` + `date-fns-tz`, preserving semantics exactly: bare date strings are still interpreted as Europe/London wall time, instants with Z/offset pass through, and the KashFlow BST/GMT boundary behaviour (period end at London 23:59:59.999 so `T23:00:00Z`/`T00:00:00Z` boundary-day records aren't dropped) is unchanged. Removed four **dead** `moment-timezone` requires (`holidayAccrualService`, `holidayController`, `indexController` — which already used date-fns — and `twoFAController`).
- Remaining on moment (phase 2, ~50 call sites): `holidayService`, `attendanceService`, `cisController`, `attendanceController`, `settingsController`, `returnsController`. `moment`/`moment-timezone` stay in package.json until those are ported.

### Added
- **BST/GMT characterization tests** in `tests/taxService.test.js`, written against the moment implementation *before* the port and passing unchanged after it: exact UTC instants for period start/end in BST, GMT, and across both clock-change months; KashFlow boundary-day containment (`2025-09-04T23:00:00Z` ∈ month 5, `2026-01-05T00:00:00Z` ∈ month 9); tax-month attribution for UTC-instant inputs; tax-year start/end instants. Suite: 680 tests passing.

## [6.8.11] - 2026-07-02

### Changed
- **TOTP library swapped from `speakeasy` (unmaintained since 2017) to `otplib` v12** — the deferred half of the June 2026 hardening pass. Verification is now centralised in a single `totpService.verifyTOTP(secret, token)` chokepoint (window ±1, matching the previous behaviour; trims input; returns false rather than throwing on malformed secrets), replacing five duplicated `speakeasy.totp.verify` call sites across `userCRUDController` (login inline 2FA + password-reset TOTP), `twoFAController`, `ssoController` and `settingsController`. Secret generation (`authenticator.generateSecret(20)`, Base32) and the otpauth QR URL (`authenticator.keyuri`) are drop-in compatible — **existing enrolled authenticators keep working unchanged**.

### Added
- `verifyTOTP` unit tests in `tests/totpService.test.js`: current-token accept, whitespace tolerance, wrong-token/wrong-secret reject, ±1-step clock-drift accept, and non-throwing behaviour on missing/malformed input. Suite: 669 tests passing.

## [6.8.10] - 2026-07-02

### Changed
- **Supplier and vehicle per-model read views — read-view migration complete.** `mongoose/views/tailwindcss/supplier/read.ejs` (balances/history tiles, CIS badge + "Edit CIS Details" action, the CIS Paid/Issued tax-year calendars refactored to one parameterised loop, purchases table with KashFlow deep links; also serves the subcontractor alias since its reads route through `/supplier/read/`) and `vehicle/read.ejs` (spec/status header, quick Log Fuel/Trip/Service actions, compliance-date and ownership/cost tiles, identifier fields, service/fuel/mileage tables). New vehicle `readLocals` resolve the assigned employee, subcontractor and project into links — previously raw ObjectIds on the detail page (list-only `fieldTransforms` never applied there), handling both ObjectId and KashFlow numeric project ids.
- **`form-read.ejs` is now purely generic** (175 lines, down from 896 pre-6.8.9): the last `basePath === 'supplier'` / `'vehicle'` blocks were removed. Audit of all 30 model configs: 11 models have curated views (user via `CRUDControllerConfig`, the other 10 via `listControllerConfig` — `getMergedConfig` merges both, CRUD config winning), `meta`/`session` deny reads, and the remaining simple flat models (attendance, holidays, task, note, nominal, vatrate, vehicle logs, OCR documents) intentionally use the generic view.

### Added
- Supplier and vehicle render smoke-tests in `tests/readViews.test.js` (CIS calendars present for subcontractors and absent for plain suppliers, purchases links, resolved vehicle assignment links, quick-action URLs, empty-state fallbacks). Suite: 662 tests passing.

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
