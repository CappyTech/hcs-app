@AGENTS.md

## Active project: Paperless → hcs-app migration

Before working on anything to do with document processing, read `PAPERLESS-MIGRATION.md` in full. That covers Paperless ingest, the document queues, invoice or statement data entry, the document viewer, sending to KashFlow, and email or Discord notifications.

- Work through its **section 0 task order** (H1 → H8), one step per branch.
- Never call live Paperless, KashFlow, email or Discord during development. Use `PAPERLESS_URL=mock` and `NOTIFY_MODE=shadow`.
- Stop and ask Jack at every ⏸ point, and whenever the document doesn't cover a decision.
