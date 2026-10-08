# Handoff: Moving document-processing logic from Paperless into hcs-app

**Date:** 29 September 2026
**Location:** `PAPERLESS-MIGRATION.md` (referenced from `CLAUDE.md` and `AGENTS.md`)
**Systems:** Paperless-ngx 3.2.1 (`docs.heroncs.co.uk`, container `hcs-paperless` on server2-host) · hcs-app (`CappyTech/hcs-app`, `master`) · KashFlow

---

## 0. Task order (for Claude Code or whoever builds this)

Read sections 1–6a before starting. **Work through H1 to H8 strictly in order.** H9 is manual clean-up after cutover and is not part of this build.

**Ground rules**

- **One step per branch or pull request** (`h1-tag-merge`, `h2-state-model`, and so on). A step isn't done until its tests pass using the mock Paperless client (section 6a).
- **Never call live Paperless, KashFlow, email or Discord** during development. Use `PAPERLESS_URL=mock` and `NOTIFY_MODE=shadow`.
- **Don't change existing behaviour outside the step in hand.** Phase 1 is parity only: every PB item in section 4 must behave exactly as it does today.
- **Follow `AGENTS.md`:** Node 24, `npm test` before every commit, and a clean `git status` before finishing. Read `docs/UI-GUIDELINES.md` before any EJS or UI change (H4, H5). Its no-inline-script rule means the PDF.js viewer is set up from a separate file under `public/`, not a `<script>` block in the view.
- **Stop and ask Jack** before anything marked **⏸** below, and whenever this document doesn't cover a decision.

**Sequence**

| Step | Depends on | Delivers | Done when |
|---|---|---|---|
| **H1** Stop the tag wipe | – | D2 uses `bulk_edit` `modify_tags` (add `added`, remove `data entry done`); `alreadySentLock` matches `claimSend` (5.1, 5.2); check 5.3 | Tests show other tags survive a send, and the lock shows correctly with extra tags. **⏸ Jack deploys** (this is the only step that goes live on its own) |
| **H2** State model | H1 | Processing state on `OcrDocument` (including `manual_kashflow`), plus `NotificationLog` with a unique index on (paperlessId, kind) | Index rejects a duplicate one-shot notification; state transitions are unit-tested |
| **H3** Ingest trigger | H2 | Webhook endpoint protected by a secret, plus a reconciliation job | Mock "document added" creates the record once; reconciliation catches a missed webhook |
| **H4** Queues | H2, H3 | Needs Data Entry, Ready for KashFlow, and Statements to Review pages | Queue contents match the rules in PB-3, PB-7, PB-10, PB-11 and PB-12 on fixtures |
| **H5** Entry screen and viewer | H4 | PDF proxy route, PDF.js viewer with text layer, OCR text panel, forms by document type, Credit Note checkbox | Every field in section 3 can be entered; text copies out of fixture PDFs |
| **H6** Notifications | H2, H5 | Email and Discord service using the section 3a templates, recorded in `NotificationLog`, shadow mode by default | Each PB notification fires exactly once in tests; re-send fires every time |
| **H7** Migration | H2 | Idempotent backfill script built from the table in H7 | Running it twice changes nothing the second time. **⏸ Jack runs it against live data** |
| **H8** Shadow run, then cutover | H1–H7 | Daily comparison report of "would send" against what Paperless actually sent | **⏸ Jack decides cutover**: disables Paperless WF2, 3, 4, 5, 8 and 9, and sets `NOTIFY_MODE=live` |

### 0a. Decisions made during the build

Agreed with Jack on 2 Oct 2026, filling gaps this document didn't cover.

- **Branches and PRs.** Each step is pushed and gets a PR. Branches are stacked (`h2-state-model` off `h1-tag-merge`, `h3-…` off `h2-…`, and so on), and nothing merges to `master` until Jack chooses to.
- **States can move backwards.** Unlinking a KashFlow purchase, or the orphan clean-up, moves `sent` back to `entered`. An admin-only **Reopen entry** moves `entered` back to `awaiting_entry`. Every move is recorded in `processingHistory`.
- **Credit notes can be unflagged by an admin**, which moves `manual_kashflow` back to `awaiting_entry`. Bev's one-shot E2 email is not sent again. An invoice already in KashFlow must be unlinked before it can be flagged.
- **No state until classified.** Existing documents have `processingState: null` until H3 ingest or the H7 backfill sets one. Only Purchase and Subcontractor Invoices get a state. Supplier statements use `statementReviewed`. Bank statements and remittances get nothing.
- **Storage.** `NotificationLog` lives in the PAPERLESS namespace. Each state or flag change stores who (user id and name) and when, plus a `processingHistory` entry. `excludedReason` is `original_multiple` (tag 4) or `manually_added` (tag 11).
- **One-shot uniqueness** is a partial unique index on (paperlessId, kind) covering rows with `oneShot: true`, so `john_resend` rows can repeat.
- **H3 derives the first state from Paperless tags** using the H7 table (`added` → `sent`, tag 22 or field 58 → `manual_kashflow`, `data entry done` → `entered`, otherwise `awaiting_entry`; tags 4/11 → `excludedReason`; tag 21 → `statementReviewed`). This means an invoice already entered or sent in Paperless is never put back into Needs Data Entry, even if H3 sees it before H7 has run. It only fills an empty state, never overrides one, and writes no `NotificationLog` rows. H7 reuses the same function (`initialStateFromPaperless` in `documentIngestService.js`) and adds the log rows. The reconciliation job only classifies documents modified inside its lookback window, so the historical backlog is still left to H7 (⏸).

- **H4 queue rules.**
  - **Ready for KashFlow:** state `entered` only, with no `excludedReason` filter. This matches view 4, which is just "has tag 1".
  - **All queues:** leave out documents with `deletedInPaperlessAt` set. A trashed test document showed up during the H3 live test.
  - **Unclassified invoices** (no state yet, before H7) are counted in a note on the page rather than shown in a queue.
  - **Read-only:** the queue pages have no actions. Actions arrive with H5 and H6.
- **`classifiedAt` (6.45.1).** Classification stamps it on invoices and supplier statements. A statement has no `processingState`, and `statementReviewed` defaults to false, so without the stamp all 41 historical statements showed as "to review". Statements to Review now requires `classifiedAt`, and **H7 must set it** on every invoice and statement it backfills.

- **H5: entered values are stored in MongoDB only** (`OcrDocument.entry`) and are not mirrored to the Paperless custom fields. The KashFlow draft reads the entry first and falls back to the Paperless fields for anything blank. When the entry has its own lines, they replace Paperless's lines entirely. The form pre-fills from the Paperless fields until something is saved in hcs-app.
- **H5 actions also update Paperless until cutover**, so its workflows keep sending the emails:
  - Complete entry adds `data entry done` (WF3 emails John).
  - Credit note sets field 58 (WF5 emails Bev).
  - Reopen removes `data entry done`.

  The hcs-app state change is made first and counts. If Paperless can't be updated, the screen says what to do by hand. H6/H8 replace the Paperless sends.
- **H5 Complete entry needs** an invoice number, invoice date, invoice total and at least one line with a description and a total. Totals that don't add up are warnings, not blockers; the KashFlow send validates again. Unit prices keep 4 decimal places.
- **H5 file route** is `GET /paperless/ocr/:paperlessId/file` rather than `/documents/:paperlessId/file`, to sit under the existing Paperless guard and route prefix.

- **H6: hcs-app follows Paperless tag changes until cutover** (agreed 3 Oct 2026). When an ingest sees that a document has progressed in Paperless, the state moves forward as the system user, and the matching notification is recorded with `source: 'paperless'`:
  - `data entry done` → entered
  - `added` → sent
  - tag 22 or field 58 → manual_kashflow
  - tag 21 → reviewed

  It never moves backwards. Without this, the shadow run would only see documents handled in hcs-app. `PAPERLESS_FOLLOW_TAGS=false` turns it off at cutover.
- **H6 triggers:**
  - **new_doc:** fired by the webhook, or by reconciliation for a document *added* inside its lookback window.
  - **john:** Complete entry. Purchase Invoices only, as WF3.
  - **john_resend:** the Resend button. Until cutover it also adds the `notify` tag, so Paperless (WF9) sends.
  - **kashflow:** a successful send.
  - **credit_note:** flagging. Purchase Invoices only, as WF5. One-shot, so flagging again after an admin unflags doesn't re-email Bev.
  - **statement:** Mark reviewed. This doesn't tag Paperless, because adding tag 21 would stop WF2 emailing Bev before cutover.
- **H6 unlink** removes `added` in Paperless as well as moving `sent` → `entered`. Otherwise following the tags would move it straight back. `notified/kashflow` stays.
- **H6 failures:** a live send that fails stays `failed`, with per-channel results. The `paperless-notification-retry` job resends only the failed channels, with backoff from 10 minutes doubling, up to 5 attempts.
- **Check in the H8 shadow comparison** two template details that weren't confirmed against live Paperless:
  - `{{created}}` is rendered as `YYYY-MM-DD`.
  - A missing correspondent is rendered as `None`.

- **H7 backfill rules:**
  - The state comes from `initialStateFromPaperless()`, the same function as H3.
  - A document that already has a state is never changed, apart from stamping a missing `classifiedAt`. hcs-app's own state wins, and following Paperless handles any later progress.
  - The legacy `credit/refund` tag (8) alone does **not** make a credit note. Only tag 22 or field 58 does, as in the H7 table.
  - Paperless's "new document" post isn't recorded for old documents, because WF8 only existed from 29 Sep. Old documents never trigger `new_doc` anyway; that only fires on arrival.
  - Documents deleted in Paperless are skipped.

- **H8: how the shadow report finds Paperless's sends.**
  - **Emails and the KashFlow post** are read from Paperless's own tags: john = tag 19 (also set by WF9 re-sends), kashflow = tag 20, statement = tag 21, credit_note = tag 22. A document counts in a window when it was modified in that window.
  - **The new-document post** counts against every document added in the window.
  - **Pending, not mismatches:** anything under 30 minutes old, to allow for the 15-minute follow.
  - **Not compared:** H7 backfill rows are history and are left out. Re-sends have no Paperless evidence, so they're counted only.
  - **Wording:** the report can't compare text, so the date format and the "None" correspondent (see H6) are checked by eye against Discord, using hcs-app's post shown for each mismatch.
- **H8 compares only from when shadow recording began** (6.49.1): the first non-backfill NotificationLog row. Documents that arrived before then were only ever sent by Paperless, and listing them as "missing" was a false alarm (27 on the first day).
- **H8 daily reports** are saved per UTC day by `paperless-shadow-report` (every 6 hours, upserting yesterday). The cutover checklist is on `/paperless/shadow-report` and in §0d.

### 0b. H3 setup in Paperless (⏸ Jack, at deploy)

1. Set `PAPERLESS_WEBHOOK_SECRET` in hcs-app to a long random value. The endpoint answers 503 until you do.
2. In Paperless, add a workflow named **hcs-app: Document added**. Trigger: *Document added*, all documents. Action: *Webhook*.
   - URL: `https://app.heroncs.co.uk/api/paperless/webhook`
   - Use parameters, send as JSON, with one parameter: `doc_url` = `{{doc_url}}`
   - Header: `Authorization` = `Bearer <the secret>`
3. Check it: upload a test document and confirm it appears in hcs-app with a state, or that the request shows in the hcs-app log. The `paperless-ingest-reconcile` job (every 15 minutes, on `/admin/jobs`) picks up anything the webhook misses.

### 0c. Running the H7 backfill (⏸ Jack)

Inside the hcs-app container on server2:

1. `docker exec -it hcs-app node scripts/paperless-backfill.js --grab` runs a dry run after refreshing every document from Paperless. Read the report: invoices by state, exclusions, statements, and notification records.
2. `docker exec -it hcs-app node scripts/paperless-backfill.js --apply` writes.
3. Run step 2 again. Every count should be 0 and "Documents with nothing to do" should equal the documents read.
4. Check `/paperless/queues`. Needs Data Entry, Ready for KashFlow and Statements to Review should match Paperless views 12, 4 and 13, and the "not classified yet" note should be gone.

### 0d. Cutover (⏸ Jack decides, H8)

1. About a week of clean daily reports on `/paperless/shadow-report`. Also compare a few of hcs-app's posts by eye with Discord, for the date format and wording.
2. Set the recipient emails and the Discord webhook URL on Configuration → Document notifications.
3. In Paperless, disable WF2, 3, 4, 5, 8 and 9.
4. In the same hour, set Mode to **Live**, and turn **Follow Paperless tags** off on the Paperless settings page.
5. Later, once entry has fully moved to hcs-app, retire WF6 and WF7. Keep WF1 and the mail rules. H9 clean-up comes after about a month of stable running.

## 1. Decision

Paperless becomes **intake, OCR and archive only**. hcs-app owns **all process logic**: queues, data entry, state, notifications and the KashFlow send.

This happens in two phases:

- **Phase 1: parity.** hcs-app reproduces exactly what the Paperless workflows do today (section 4). No behaviour changes are visible to Bev, John or the Discord channel.
- **Phase 2: improve.** Only once parity is confirmed: cut data entry, add real approvals, and so on (section 8).

Data entry stays manual in Phase 1; it just moves from Paperless custom fields into hcs-app.

---

## 2. The process today (reference IDs)

These stage IDs are used throughout this document.

### A. Arrival
- **A1.** A supplier emails purchase@, bank@, statement@, remittance@ or subcontractor@. All five land in one M365 mailbox.
- **A2.** Paperless polls INBOX using M365 OAuth. Five mail rules match on the To address. They take PDF attachments only, from emails up to 30 days old.
- **A3.** The rule sets the document type and a type tag, and takes the title from the email subject. It sets no correspondent.
- **A4.** The email is moved to `ProcessedByPaperless`.
- **A5.** Documents can also arrive by manual upload in the Paperless web interface.

### B. Consumption (Paperless, automatic)
- **B1.** WF1 sets the title to `{{filename}}`, the owner to Jack, and view/change permissions for Bev, John and the admin group.
- **B2.** OCR runs.
- **B3.** The classifier assigns the correspondent.
- **B4.** The document is saved with the `inbox` tag. "Document added" then fires WF6, WF7 and WF8 (section 3).

### C. Review and data entry (manual, currently in Paperless)
- **C1.** Someone fills in the invoice custom fields: header fields plus up to 7 line items.
- **C1-end.** Someone adds `data entry done`, which triggers E1.
- **C2a.** Supplier statements: the first save sends Bev an email (WF2).
- **C3.** `inbox` is removed by the web interface's auto-remove-on-save setting.

### D. KashFlow entry (manual, hcs-app)
- **D1.** The invoice waits in "Queue: Ready for KashFlow" until someone sends it from hcs-app's draft screen.
- **D2.** hcs-app writes the KashFlow Purchase Id, Number, Permalink and Last Send Status custom fields, then **replaces all tags with just `added`** (see 5.1).
- **D3.** WF4 posts "added to KashFlow" to Discord.

### E. Notifications
- **E1.** John is emailed the invoice PDF (WF3), or re-sent it when someone adds `notify` (WF9).
- **E2.** Bev is emailed credit notes when the Credit Note field is ticked (WF5).

### F. Outside Paperless
- **F1.** hcs-sync pulls KashFlow into MongoDB. It never writes to Paperless.
- **F2.** Bank statements are ingested by hcs-app's `bankStatementIngestService`, which tags with `merge: true`. Remittances have no follow-on process.

---

## 3. Paperless configuration inventory (as of 29 Sep 2026)

### Workflows

| ID | Order | Name | Trigger and filters | Actions |
|---|---|---|---|---|
| 1 | 1 | Owner, Permissions and Title | Consumption started, all | Title `{{filename}}`, owner Jack, permissions (Bev, John, admin group) |
| 6 | 2 | Fields: Invoices | Document added; type Purchase Invoice or Subcontractor Invoice | Add custom fields 1–10, 13, 58 (Credit Note = false) |
| 7 | 3 | Fields: Bank Statements | Document added; type Bank Statement | Add custom fields 53–57 |
| 8 | 4 | Discord: New Document | Document added, all | Discord: `New document: {{filename}} ({{document_type}}) from {{correspondent}} - {{doc_url}}` |
| 2 | 5 | Email Admin Statements | Updated; type Supplier Statement; lacks tag 21 | Email Bev with PDF, Discord, add tag 21 |
| 9 | 6 | Resend Invoice to John | Updated; has tag 10 (`notify`); type Purchase Invoice | Email John with PDF, Discord `Re-sent invoice to John…`, add tag 19, remove tag 10 |
| 3 | 7 | Email John Invoices | Updated; has tag 1 (`data entry done`); lacks tag 19; type Purchase Invoice | Email John with PDF, Discord `Emailed invoice to John…`, add tag 19, remove tag 10 |
| 4 | 8 | Notify Added to Kashflow | Updated; has tag 2 (`added`); lacks tag 20 | Discord `Document added to kashflow: {{filename}} - {{doc_url}}`, add tag 20 |
| 5 | 9 | Email Admin Credit Note | Updated; custom field 58 = true; lacks tag 22; type Purchase Invoice | Email Bev with PDF, Discord, add tag 22 |

- All emails and Discord posts use the sender name **"Heron CS | Documents"**.
- The Discord webhook URL is stored in the workflows. **Move it to an hcs-app environment variable; don't commit it.** It is deliberately not written in this document.
- The exact template text is in section 3a.

### 3a. Notification templates (exact, as live on 29 Sep 2026)

Placeholders are Paperless's. In hcs-app, map them as follows:

| Placeholder | hcs-app value |
|---|---|
| `{{filename}}` | Paperless title, which WF1 sets to the original filename |
| `{{correspondent}}` | Supplier / correspondent name |
| `{{document_type}}` | Document type name |
| `{{created}}` | Document date |
| `{{doc_url}}` | `https://docs.heroncs.co.uk/documents/<id>/details`, or the hcs-app document page once that exists |

Every email below **attaches the PDF**.

**E1: John, invoice** (WF3 on completion; WF9 re-send uses the identical text)
- To: `john.oldfield@heroncs.co.uk`
- Subject: `New purchase invoice: {{filename}} from {{correspondent}}`
- Body:
  ```
  A new purchase invoice has been added to Heron CS | Documents.


  Title: {{filename}}
  Type: {{document_type}}
  Date: {{created}}

  {{doc_url}}

  Document Attached.
  ```

**C2a: Bev, supplier statement** (WF2)
- To: `bev.oldfield@heroncs.co.uk`
- Subject: `New statement: {{filename}} from {{correspondent}}`
- Body:
  ```
  A new statement has been added to https://docs.heroncs.co.uk/

  Title: {{filename}}
  Type: {{document_type}}
  Date: {{created}}

  Statement: {{doc_url}}
  ```

**E2: Bev, credit note** (WF5)
- To: `bev.oldfield@heroncs.co.uk`
- Subject: `New credit note: {{filename}} from {{correspondent}}`
- Body:
  ```
  A new credit note has been added to https://docs.heroncs.co.uk/

  Title: {{filename}}
  Type: {{document_type}}
  Date: {{created}}

  Credit note: {{doc_url}}
  ```

**Discord messages**

Payload: `{"username": "Heron CS | Documents", "content": "<text>"}`, sent as a raw JSON body with `Content-Type: application/json`.

| Event | Content |
|---|---|
| PB-1 new document (WF8) | `New document: {{filename}} ({{document_type}}) from {{correspondent}} - {{doc_url}}` |
| C2a statement emailed (WF2) | `Emailed statement to Admin: {{filename}} - {{doc_url}}` |
| E1 John emailed (WF3) | `Emailed invoice to John: {{filename}} - {{doc_url}}` |
| E1 re-send (WF9) | `Re-sent invoice to John: {{filename}} - {{doc_url}}` |
| D3 in KashFlow (WF4) | `Document added to kashflow: {{filename}} - {{doc_url}}` |
| E2 credit note emailed (WF5) | `Emailed credit note to Admin: {{filename}} - {{doc_url}}` |

Recipients are settings, not hard-coded: `NOTIFY_INVOICE_EMAIL` (E1, John today), `NOTIFY_STATEMENT_EMAIL` (C2a, Bev today) and `NOTIFY_CREDIT_NOTE_EMAIL` (E2, Bev today).

### Mail rules
There are five rules on one M365 account, INBOX folder. They are split by To address:

| Address | Document type | Tag |
|---|---|---|
| purchase@ | Purchase Invoice | `purchase-invoice` |
| statement@ | Supplier Statement | `supplier-statement` |
| subcontractor@ | Subcontractor Invoice | `subcontractor-invoice` |
| remittance@ | Remittance Advice | `remittance-advice` |
| bank@ | Bank Statement | `bank-statement` |

Every rule moves the email to `ProcessedByPaperless`.

### Tags

| ID | Name | Role |
|---|---|---|
| 1 | data entry done | End of data entry (C1-end); removed at D2 |
| 2 | added | In KashFlow (set at D2) |
| 3 | inbox | Inbox tag (matching: None) |
| 4 | original/multiple invoice one pdf | Source PDF holding several invoices; excluded from queues |
| 5, 16, 17, 18 | supplier-statement, purchase-invoice, subcontractor-invoice, remittance-advice | Duplicate the document type (matching: None) |
| 8 | credit/refund | Legacy credit note marker, replaced by custom field 58 |
| 9 | notified | Parent of the flags below; no longer used as a filter |
| 10 | notify | Manual re-send to John |
| 11 | manually added to kashflow | Entered in KashFlow outside hcs-app; excluded from queues |
| 19 | notified/john | E1 sent |
| 20 | notified/kashflow | D3 sent |
| 21 | notified/admin-statement | C2a sent |
| 22 | notified/credit-note | E2 sent |

The bank-statement tags (`bank-statement`, `bank-statement/parsed`, `/needs-review`, `/failed`) are owned by hcs-app's ingest service.

### Document types
| ID | Name |
|---|---|
| 1 | Purchase Invoice |
| 2 | Supplier Statement |
| 3 | Subcontractor Invoice |
| 4 | Bank Statement |
| 5 | Remittance Advice |

Bank tag IDs (owned by the hcs-app ingest service): 12 `bank-statement`, 13 `bank-statement/parsed`, 14 `bank-statement/needs-review`, 15 `bank-statement/failed`.

### Custom fields (complete)

**Invoice header** (added by WF6)

| ID | Name | Type |
|---|---|---|
| 1 | Invoice Number | string |
| 2 | Invoice Date | date |
| 3 | Total Goods | monetary |
| 4 | Total VAT | monetary |
| 5 | Invoice Total | monetary |
| 6 | Invoice Due Date | date |
| 58 | Credit Note | boolean (default false) |

**Line items.** Only line 1 is added by default; lines 2–7 are added by hand when needed.

| Line | Description_LineN (string) | Qty_LineN (float) | Price_LineN (monetary) | Total_LineN (monetary) | VAT_LineN (integer) |
|---|---|---|---|---|---|
| 1 | 7 | 8 | 9 | 10 | 13 |
| 2 | 14 | 15 | 16 | 17 | 18 |
| 3 | 19 | 20 | 21 | 22 | 23 |
| 4 | 24 | 25 | 26 | 27 | 28 |
| 5 | 29 | 30 | 31 | 32 | 33 |
| 6 | 39 | 40 | 41 | 42 | 43 |
| 7 | 44 | 49 | 50 | 51 | 52 |

Line-item usage across all documents: line 1 on about 1,000 documents, line 2 on 22, line 3 on 14, line 4 on 8, line 5 on 7, line 6 on 4, line 7 on 2. In hcs-app, model line items as a **variable-length array** rather than 7 fixed slots.

**KashFlow** (written by hcs-app at D2, all strings): 34 KashFlow Purchase Id, 35 KashFlow Purchase Number, 36 KashFlow Purchase Permalink, 37 KashFlow Last Send Status.

**Bank statement** (added by WF7): 53 Bank Account ID (float), 54 Statement Period Start (date), 55 Statement Period End (date), 56 Statement Opening Balance (monetary), 57 Statement Closing Balance (monetary).

Paperless monetary values are strings that may carry an ISO currency prefix, for example `GBP123.45` or `123.45`. Handle both when reading them.

### Saved views (the queues)

| ID | Name | Filter |
|---|---|---|
| 12 | Queue: Needs Data Entry | Type Purchase Invoice or Subcontractor Invoice, **and** lacks tags 1, 2, 11, 4 and 22 |
| 4 | Queue: Ready for KashFlow | Has tag 1 |
| 13 | Queue: Statements to Review | Type Supplier Statement, **and** lacks tag 21 |

### Volumes
- About 1,030 documents in total, 960 of them in KashFlow.
- 970 correspondents, of which 902 have no documents. They look like an import of the KashFlow supplier list.
- The top 8 suppliers account for roughly 75% of documents.

---

## 4. Parity spec: what hcs-app must reproduce

Each behaviour gets a PB-ID. Phase 1 is done when every PB passes its check.

| PB | Current behaviour (source) | hcs-app equivalent | Parity check |
|---|---|---|---|
| PB-1 | Discord post for every new document (WF8) | Post when a new Paperless document is first ingested | One post per new document, same wording and link |
| PB-2 | Invoices get invoice fields; bank statements get statement fields (WF6, WF7) | Entry form chosen by document type; Paperless custom fields are no longer the entry location | Correct form per type; remittances have none |
| PB-3 | Needs Data Entry queue (view 12) | Queue: type PI or SI, state `awaiting_entry`, excluding "original/multiple" and "manually added" | Same documents as view 12 on the same day |
| PB-4 | Data entry of header fields plus up to 7 lines (C1) | hcs-app entry screen, reusing the draft screen's validation (supplier, nominal per line, totals consistent, currency) | Every field enterable today can be entered in hcs-app |
| PB-5 | `data entry done` emails John once (WF3) | Action **Complete entry** moves state to `entered` and sends E1 once | Exactly one email with PDF attached; saving again sends nothing |
| PB-6 | `notify` re-sends to John (WF9) | **Resend to John** button, always sends and is logged | Sends each time it's clicked |
| PB-7 | Ready for KashFlow queue (view 4) | Queue: state `entered` | Same documents as view 4 |
| PB-8 | Send to KashFlow, then Discord post (D2, WF4) | Existing `sendDraftToKashflow`, then state `sent`, then post D3 once | One post per successful send; `claimSend` still prevents double sends |
| PB-9 | Credit note emails Bev once (WF5) | **Credit note** checkbox on the entry screen sends E2 once when first set | One email per credit note |
| PB-10 | Statements to Review queue, and Bev emailed on first review (view 13, WF2) | Statement queue plus a **Mark reviewed** action that sends C2a once | One email per statement |
| PB-11 | Documents can't silently drop out of queues | Queues are driven by hcs-app state, not by Paperless tags or the inbox | A document opened and saved without completing stays in its queue |
| PB-12 | Credit notes are not entered in KashFlow at all (corrected 8 Oct 2026; earlier this said "by hand"); they're excluded from the Needs Data Entry queue by the `notified/credit-note` tag (22) | A credit note gets state `manual_kashflow` once flagged; it leaves both invoice queues and is never offered for the KashFlow send | A flagged credit note appears in neither queue, and the send action is unavailable for it |

Leave **WF1** (owner, permissions, title) and the **mail rules** in Paperless. They are intake concerns.

---

## 5. Known issues in hcs-app found during review

### 5.1 D2 wipes every Paperless tag
In `mongoose/controllers/paperlessController.js`, around line 1224:

```js
await updatePaperlessDocumentTags(paperlessId, ["added"])   // no { merge: true }
```

`updatePaperlessDocumentTags` replaces tags by default. This strips `notified/*`, `credit/refund`, `inbox`, the type tags, `original/multiple…` and `manually added to kashflow`.

`bankStatementIngestService` already uses `merge: true`, and a test enforces it there.

**Fix (H1):** switch to Paperless `bulk_edit` with `modify_tags`: add `added`, remove `data entry done`. This is atomic, unlike the current read-then-write merge path.

### 5.2 `alreadySentLock` depends on the tag wipe
Around lines 610–622, the lock requires `added` to be the **only** tag. Once WF4 adds `notified/kashflow`, the UI no longer shows the invoice as sent.

`claimSend` in `kashflowSendClaimService.js` (checks `kashflowPurchaseId` plus status 201) still blocks the actual send, so it's safe, but the UI is misleading.

**Fix (H1):** use the same test as `claimSend`.

### 5.3 Custom field write-back may overwrite newer values (to verify)
`updatePaperlessWithKashFlowInfo` uses `updateDocumentCustomFieldsDirect` with `existingCf` taken from MongoDB. If a field was changed in Paperless after hcs-app last ingested the document, it may be overwritten. This becomes moot once entry moves to hcs-app, but it needs checking before H1 ships.

---

## 6. hcs-app work plan

### H1: Stop the tag wipe (ship first, independent of the rest)
- Replace the D2 tag call with `modify_tags` (5.1). Fix `alreadySentLock` (5.2).
- **Check:** after a send, the document keeps its other tags. Because `notified/kashflow` is now kept rather than wiped, WF4 still fires exactly once.

### H2: Data model
- Add processing state to `OcrDocument`: `awaiting_entry` → `entered` → `sent`, plus the terminal state `manual_kashflow` for credit notes (PB-12), plus `statementReviewed`, `creditNote`, `excludedReason` (original/multiple, manually added), and who changed each and when.
- New `NotificationLog` collection with a **unique index on (paperlessId, kind)** for one-shot notifications. Kinds: `new_doc`, `john`, `kashflow`, `statement`, `credit_note`. Re-sends go in with `kind: john_resend` and no uniqueness.
- The unique index is what replaces all the `notified/*` tags. It makes "exactly once" a database guarantee rather than a tag convention.

### H3: Ingest trigger
- Add a Paperless webhook, a "Document added" workflow posting to an hcs-app endpoint protected by a shared secret, so new documents reach hcs-app immediately.
- Keep a periodic reconciliation job built on the existing auto-ingest, so nothing is missed if the webhook fails.
- Use `PAPERLESS_PROXY_SSL_HEADER` on the Paperless side. API `next` links currently come back as `http://`; hcs-app's pagination should strip the host anyway.

### H4: Queues (PB-3, PB-7, PB-10, PB-11)
- Three queue pages driven by H2 state, oldest first.

### H5: Entry screen with document viewer (PB-2, PB-4, PB-9)
- Show the PDF alongside the form for the document type. Reuse the existing draft screen and its validation.
- Store values in MongoDB. Optionally mirror them to Paperless custom fields for searchability; decide during build.

**Viewing the document without duplicating files**

Paperless stays the only file store. hcs-app **streams** the PDF through its own server rather than copying it:

- Add a route `GET /documents/:paperlessId/file`, behind hcs-app login. It uses the existing Paperless API client (server-side token) to fetch the file and pipes it back with `Content-Type: application/pdf`.
- The browser never needs Paperless credentials, and nothing is stored twice.
- Optionally cache files on disk or in memory with a short time-to-live, if repeated loads become slow. A cache is disposable; Paperless remains the source of truth.

Which Paperless file to fetch:
- **`/api/documents/<id>/preview/`** serves the archived (OCR'd) version if one exists, otherwise the original.
- Checked on document 1069: `has_archive_version: false`, meaning the original PDF is served. Paperless 3.x only creates an archive version when it needed to OCR the file.
- Either way the file has a text layer, as long as Paperless's OCR ran, so copy and paste works.

Rendering:
- Use **PDF.js (`pdfjs-dist`)** in the browser. Its **text layer** lets users select and copy text straight from the rendered invoice, which covers the copy-and-paste requirement.
- `pdfjs-dist` is used on the frontend (hcs-app's views). Node only proxies the bytes, so no server-side PDF rendering is needed.
- Serve the `pdfjs-dist` build and its worker from hcs-app's static assets rather than a CDN. Set up the viewer from its own file under `public/`, because `docs/UI-GUIDELINES.md` doesn't allow inline scripts.
- Also useful: Paperless's `content` field (`GET /api/documents/<id>/`) holds the full OCR text. Show it in a collapsible panel as a fallback for copying, and later as the input for automatic extraction in Phase 2.

### H6: Notification service (PB-1, PB-5, PB-6, PB-8, PB-9, PB-10)
- Email with the PDF attached, and Discord. Use the exact templates in section 3a. For the attachment, fetch the PDF through the same Paperless client used by the H5 viewer route.
- Every send is written to `NotificationLog`.
- Needs an email sending route from hcs-app, either M365 SMTP or Graph. Check what hcs-app already has.

### H7: Migration
Backfill state from Paperless so nothing historical fires:

| Paperless | hcs-app |
|---|---|
| `added` | state `sent` and a `kashflow` log entry |
| tag 21 | `statementReviewed` and a `statement` log entry |
| tag 22 or field 58 | `creditNote` and a `credit_note` log entry |
| tag 19 | `john` log entry |
| tags 4 and 11 | `excludedReason` |

### H8: Shadow run, then cutover
1. Run hcs-app in **shadow mode** for about a week. It logs "would send X" without sending, while Paperless keeps sending. Compare the two daily.
2. Cutover: disable Paperless WF2, 3, 4, 5, 8 and 9, then switch hcs-app sends on the same hour.
3. Retire WF6 and WF7 once entry has moved to hcs-app.
4. Keep WF1 and the mail rules.

### H9: Paperless clean-up (after about a month stable)
- Retire the `notified/*` tags, `notify`, `data entry done`, `credit/refund`, the type tags, the invoice custom fields (if they aren't being mirrored) and saved views 4, 12 and 13.
- Keep the documents themselves, and the KashFlow reference fields if hcs-app still writes them.

---

## 6a. Building without access to docs.heroncs.co.uk

Everything needed to build is in this document: IDs, field names, templates and rules. Access to Paperless is only needed at **runtime**, through its API. For development:

- **Configuration by environment variable.** hcs-app already uses `PAPERLESS_TAG_*_ID` in `paperlessTagsConfig.js`; extend the same pattern:

  ```
  PAPERLESS_URL, PAPERLESS_TOKEN
  PAPERLESS_DOCTYPE_{PURCHASE_INVOICE=1, SUPPLIER_STATEMENT=2, SUBCONTRACTOR_INVOICE=3, BANK_STATEMENT=4, REMITTANCE=5}
  PAPERLESS_WEBHOOK_SECRET          (H3)
  DISCORD_WEBHOOK_URL
  NOTIFY_INVOICE_EMAIL, NOTIFY_STATEMENT_EMAIL, NOTIFY_CREDIT_NOTE_EMAIL
  NOTIFY_MODE=shadow|live           (H8; defaults to shadow)
  ```

- **Mock Paperless client.** Add a fake implementation of the existing `paperlessClient` interface. It should serve a few fixture PDFs, plus JSON document records in the shape of `GET /api/documents/<id>/` (`id`, `title`, `correspondent`, `document_type`, `tags`, `custom_fields: [{field, value}]`, `content`, `created`, `added`). Select it with `PAPERLESS_URL=mock`.
  - Fixtures should include: a born-digital purchase invoice, a scanned invoice, a multi-line invoice (3 or more lines), a credit note, a supplier statement and a bank statement.
  - Use redacted or dummy PDFs. Don't commit real supplier documents to the repo.

- **Paperless API calls hcs-app will make**, all with the server-side token:

  | Call | Used for |
  |---|---|
  | `GET /api/documents/?page_size=…&document_type__id__in=…` | Ingest and reconciliation (H3) |
  | `GET /api/documents/<id>/` | Metadata and OCR text |
  | `GET /api/documents/<id>/preview/` | PDF for the viewer and email attachments (H5, H6) |
  | `POST /api/documents/bulk_edit/` with `method: "modify_tags"` | Tag changes (H1) |
  | `PATCH /api/documents/<id>/` with `custom_fields` | KashFlow reference write-back (existing) |

- **Mail and Discord in development.** Point email at a local catcher such as Mailpit, and leave `DISCORD_WEBHOOK_URL` unset so posts are only logged. With `NOTIFY_MODE=shadow` nothing is ever sent.

## 7. Open items (before or alongside Phase 1)

- [ ] **Documents 1005 (3 Sep) and 1069 (21 Sep):** invoices outside the inbox, never entered or sent. Probably missed; check them.
- [x] **Credit notes: resolved.** They are not entered into KashFlow at all (confirmed 8 Oct 2026; this item first said "entered by hand", which was wrong). Bev is emailed each one (E2). This is why 297, 342, 573, 609, 673 and 947 have no `added` tag. The state is still called `manual_kashflow`, kept to avoid a data migration; the screens call it "Credit note (not entered in KashFlow)". The Phase 2 credit note draft service is dropped.
- [ ] Run `document_exporter` as a backup. None was taken before the 29 September changes.
- [ ] Set `PAPERLESS_PROXY_SSL_HEADER='["HTTP_X_FORWARDED_PROTO", "https"]'` on the Paperless container.
- [ ] Tell whoever does data entry: add only `data entry done` (John's email is automatic), use `notify` only to re-send, and tick **Credit Note** instead of adding the `credit/refund` tag.

---

## 8. Phase 2 backlog (after parity)

1. ~~**Credit note draft service.**~~ Dropped (8 Oct 2026): credit notes aren't entered in KashFlow at all, so there's no manual entry to replace.
2. **Reduce data entry.**
   - Ask the accountant whether KashFlow needs line-level detail, or whether one line per nominal code would do.
   - Supplier-specific parsers to pre-fill fields from the OCR text, starting with the top suppliers (about 75% of volume).
   - Then consider a general extraction step with human confirmation.
3. **John's email.** If it's an approval, replace it with an approve/reject action in hcs-app. If it's just for information, use a daily digest.
4. **Correspondents.** Clean up the 902 correspondents with no documents, or link Paperless correspondents to KashFlow supplier IDs.
5. **Remittance advices.** Define a process, such as matching them to sales invoices.
6. **Supplier statement reconciliation.** Compare the statement against KashFlow purchases for that supplier.

---

## 9. Rollback reference for the 29 Sep 2026 Paperless changes

- **Before the change:** WF1 added fields 1–10 and 13 to every document and emailed Jack. WF2, 3, 4 and 5 all used the single tag `notified` (9) as their once-only guard. WF3 was triggered by `notify`. WF5 was triggered by the `credit/refund` tag. WF6–9, tags 19–22, field 58 and views 12–13 did not exist. View 4 was named "Tag: data entry done", sorted by created date, newest first.
- **Backfill:** tag 20 was added to all 960 documents with `added`; tag 21 to all 41 Supplier Statements; tag 22 and field 58 = true to credit notes 297, 342, 573, 609, 673 and 947.
- **Matching:** tags 3, 5, 16, 17 and 18 were changed from Auto to None.
- **Snapshot:** a full pre-change snapshot of the workflows, tags, custom fields and views is stored in the browser's localStorage on docs.heroncs.co.uk, under the key `claude_snapshot_2026-09-29`.
