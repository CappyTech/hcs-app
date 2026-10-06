# Invoice fixtures

Real (or realistic) invoices the reader is tested against by `tests/invoiceFixtures.test.js`.

Each file is what **Fixture** on `/paperless/reading` downloads: the PDF's positioned text
(`items`: `[text, x, y, width, height, page]`) and what was saved on the entry screen
(`expected`). The reader must find every saved value, apart from fields listed in
`knownMisses` (use `"lines"` for line items).

A real invoice holds a supplier's details and prices. Check it's fine to keep in this
repository before committing one, or trim it to the rows that matter.
