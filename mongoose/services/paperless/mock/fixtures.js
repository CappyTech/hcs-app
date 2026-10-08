/**
 * Fixture data for the mock Paperless client (PAPERLESS_URL=mock).
 *
 * IDs for tags, document types and custom fields match the live inventory in
 * PAPERLESS-MIGRATION.md section 3, so code resolving them through
 * paperlessTagsConfig / paperlessTypesConfig behaves exactly as it would live.
 * Documents, suppliers and amounts are invented — never put real supplier
 * documents here.
 */

export const TAGS = [
  { id: 1, name: 'data entry done', parent: null },
  { id: 2, name: 'added', parent: null },
  { id: 3, name: 'inbox', parent: null, is_inbox_tag: true },
  { id: 4, name: 'original/multiple invoice one pdf', parent: null },
  { id: 5, name: 'supplier-statement', parent: null },
  { id: 8, name: 'credit/refund', parent: null },
  { id: 9, name: 'notified', parent: null },
  { id: 10, name: 'notify', parent: null },
  { id: 11, name: 'manually added to kashflow', parent: null },
  { id: 12, name: 'bank-statement', parent: null },
  { id: 13, name: 'bank-statement/parsed', parent: null },
  { id: 14, name: 'bank-statement/needs-review', parent: null },
  { id: 15, name: 'bank-statement/failed', parent: null },
  { id: 16, name: 'purchase-invoice', parent: null },
  { id: 17, name: 'subcontractor-invoice', parent: null },
  { id: 18, name: 'remittance-advice', parent: null },
  { id: 19, name: 'notified/john', parent: 9 },
  { id: 20, name: 'notified/kashflow', parent: 9 },
  { id: 21, name: 'notified/admin-statement', parent: 9 },
  { id: 22, name: 'notified/credit-note', parent: 9 },
];

export const DOCUMENT_TYPES = [
  { id: 1, name: 'Purchase Invoice' },
  { id: 2, name: 'Supplier Statement' },
  { id: 3, name: 'Subcontractor Invoice' },
  { id: 4, name: 'Bank Statement' },
  { id: 5, name: 'Remittance Advice' },
];

export const CORRESPONDENTS = [
  { id: 1, name: 'Acme Builders Merchants', matching_algorithm: 6 },
  { id: 2, name: 'Northern Plant Hire', matching_algorithm: 6 },
  { id: 3, name: 'Example Bank plc', matching_algorithm: 6 },
];

const lineFields = [
  // [line, description, qty, price, total, vat]
  [1, 7, 8, 9, 10, 13],
  [2, 14, 15, 16, 17, 18],
  [3, 19, 20, 21, 22, 23],
  [4, 24, 25, 26, 27, 28],
  [5, 29, 30, 31, 32, 33],
  [6, 39, 40, 41, 42, 43],
  [7, 44, 49, 50, 51, 52],
];

export const CUSTOM_FIELDS = [
  { id: 1, name: 'Invoice Number', data_type: 'string' },
  { id: 2, name: 'Invoice Date', data_type: 'date' },
  { id: 3, name: 'Total Goods', data_type: 'monetary' },
  { id: 4, name: 'Total VAT', data_type: 'monetary' },
  { id: 5, name: 'Invoice Total', data_type: 'monetary' },
  { id: 6, name: 'Invoice Due Date', data_type: 'date' },
  ...lineFields.flatMap(([n, d, q, p, t, v]) => [
    { id: d, name: `Description_Line${n}`, data_type: 'string' },
    { id: q, name: `Qty_Line${n}`, data_type: 'float' },
    { id: p, name: `Price_Line${n}`, data_type: 'monetary' },
    { id: t, name: `Total_Line${n}`, data_type: 'monetary' },
    { id: v, name: `VAT_Line${n}`, data_type: 'integer' },
  ]),
  { id: 34, name: 'KashFlow Purchase Id', data_type: 'string' },
  { id: 35, name: 'KashFlow Purchase Number', data_type: 'string' },
  { id: 36, name: 'KashFlow Purchase Permalink', data_type: 'string' },
  { id: 37, name: 'KashFlow Last Send Status', data_type: 'string' },
  { id: 53, name: 'Bank Account ID', data_type: 'float' },
  { id: 54, name: 'Statement Period Start', data_type: 'date' },
  { id: 55, name: 'Statement Period End', data_type: 'date' },
  { id: 56, name: 'Statement Opening Balance', data_type: 'monetary' },
  { id: 57, name: 'Statement Closing Balance', data_type: 'monetary' },
  { id: 58, name: 'Credit Note', data_type: 'boolean' },
];

const cf = (pairs) => Object.entries(pairs).map(([field, value]) => ({ field: Number(field), value }));

export const DOCUMENTS = [
  {
    // Born-digital purchase invoice, just arrived, awaiting data entry
    id: 9001,
    title: 'INV-1001.pdf',
    correspondent: 1,
    document_type: 1,
    tags: [3, 16],
    custom_fields: cf({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: null, 13: null, 58: false }),
    content: 'Acme Builders Merchants\nInvoice INV-1001\nDate 01/09/2026\nCement 25kg x 10 @ 6.50 = 65.00\nVAT 20% 13.00\nTotal 78.00',
    created: '2026-09-01',
    added: '2026-09-01T09:00:00Z',
    modified: '2026-09-01T09:00:00Z',
  },
  {
    // Scanned purchase invoice: entered, John emailed, ready for KashFlow
    id: 9002,
    title: 'scan_0042.pdf',
    correspondent: 2,
    document_type: 1,
    tags: [1, 9, 16, 19],
    custom_fields: cf({ 1: 'NPH-778', 2: '2026-09-05', 3: 'GBP200.00', 4: 'GBP40.00', 5: 'GBP240.00', 6: '2026-10-05', 7: 'Excavator hire 1 week', 8: 1, 9: 'GBP200.00', 10: 'GBP200.00', 13: 20, 58: false }),
    content: 'NORTHERN PLANT HIRE\nInvoice No NPH-778\nExcavator hire 1 week 200.00\nVAT 40.00\nTOTAL 240.00',
    created: '2026-09-05',
    added: '2026-09-06T10:00:00Z',
    modified: '2026-09-08T14:00:00Z',
  },
  {
    // Multi-line purchase invoice (3 lines), awaiting data entry
    id: 9003,
    title: 'INV-1002.pdf',
    correspondent: 1,
    document_type: 1,
    tags: [3, 16],
    custom_fields: cf({ 58: false }),
    content: 'Acme Builders Merchants\nInvoice INV-1002\nTimber 10.00\nScrews 5.00\nSealant 15.00\nNet 30.00 VAT 6.00 Total 36.00',
    created: '2026-09-10',
    added: '2026-09-10T08:30:00Z',
    modified: '2026-09-10T08:30:00Z',
  },
  {
    // Credit note: flagged, Bev emailed, not entered in KashFlow
    id: 9004,
    title: 'CN-0007.pdf',
    correspondent: 1,
    document_type: 1,
    tags: [8, 9, 16, 22],
    custom_fields: cf({ 1: 'CN-0007', 5: 'GBP-12.00', 58: true }),
    content: 'Acme Builders Merchants\nCREDIT NOTE CN-0007\nReturned goods -10.00 VAT -2.00 Total -12.00',
    created: '2026-09-12',
    added: '2026-09-12T11:00:00Z',
    modified: '2026-09-12T11:30:00Z',
  },
  {
    // Supplier statement, not yet reviewed
    id: 9005,
    title: 'Statement Sept 2026.pdf',
    correspondent: 1,
    document_type: 2,
    tags: [3, 5],
    custom_fields: [],
    content: 'Acme Builders Merchants\nStatement of account 30/09/2026\nINV-1001 78.00\nINV-1002 36.00\nBalance 114.00',
    created: '2026-09-30',
    added: '2026-09-30T16:00:00Z',
    modified: '2026-09-30T16:00:00Z',
  },
  {
    // Bank statement, picked up by the ingest service
    id: 9006,
    title: 'bank-2026-09.pdf',
    correspondent: 3,
    document_type: 4,
    tags: [12],
    custom_fields: cf({ 53: null, 54: null, 55: null, 56: null, 57: null }),
    content: 'Example Bank plc\nStatement 01/09/2026 - 30/09/2026\nOpening balance 1,000.00\nClosing balance 1,250.00',
    created: '2026-09-30',
    added: '2026-10-01T07:00:00Z',
    modified: '2026-10-01T07:00:00Z',
  },
];

export default { TAGS, DOCUMENT_TYPES, CORRESPONDENTS, CUSTOM_FIELDS, DOCUMENTS };
