/**
 * Regenerates mongoose/config/apiDocsGenerated.js from the published IRIS KashFlow
 * Swagger 2.0 spec.
 *
 *   node scripts/generate-api-docs.mjs                 # fetches the live spec
 *   node scripts/generate-api-docs.mjs --spec kf.json  # from a saved copy
 *   node scripts/generate-api-docs.mjs --dry           # report only, write nothing
 *
 * Only operations NOT already documented by hand in apiDocsConfig.js are emitted,
 * so hand-written prose is never overwritten by spec text. Re-run it after KashFlow
 * ships new endpoints; the diff shows exactly what they added.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SPEC_URL = 'https://api.kashflow.com/v2/swagger/docs/v1';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(APP, 'mongoose/config/apiDocsGenerated.js');
const DRY = process.argv.includes('--dry');
const specArg = process.argv.indexOf('--spec');

const spec = specArg !== -1
  ? JSON.parse(fs.readFileSync(process.argv[specArg + 1], 'utf8'))
  : await (await fetch(SPEC_URL)).json();
const existing = (await import(path.join(APP, 'mongoose/config/apiDocsConfig.js'))).handWrittenApiDocs;

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];
const MAX_REQUEST_DEPTH = 3;     // renderFieldTableHtml uses pl-{4*depth}; keep to classes already in the build
const MAX_RESPONSE_FLATTEN = 2;  // the view renders response fields flat, so nesting is dotted
const MAX_TABLE_ROWS = 60;       // a few KashFlow models run to 300+ properties; past ~60 rows
                                 // the table stops being documentation and just weighs the page down

// ── helpers ────────────────────────────────────────────────────────────────
const normPath = (p) => p.toLowerCase().replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');
const segs = (p) => normPath(p).split('/').filter(Boolean);

function clean(s, max = 400) {
  if (!s) return '';
  let t = String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')      // descriptions are interpolated unescaped by renderFieldTableHtml
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

function deref(schema, seenRefs) {
  if (!schema) return { schema: null, ref: null };
  if (schema.$ref) {
    const name = schema.$ref.replace('#/definitions/', '');
    if (seenRefs.has(name)) return { schema: null, ref: name, cyclic: true };
    return { schema: spec.definitions[name] || null, ref: name };
  }
  return { schema, ref: null };
}

function typeOf(schema, ref) {
  if (!schema) return ref ? 'object' : '';
  if (schema.type === 'array') return 'array';
  if (schema.$ref) return 'object';
  if (schema.enum) return schema.type || 'string';
  if (schema.format === 'date-time') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return schema.type;
  return schema.type || 'object';
}

function enumNote(schema) {
  if (!schema || !schema.enum || !schema.enum.length) return '';
  return ` Allowed values: ${schema.enum.slice(0, 12).join(', ')}${schema.enum.length > 12 ? ', …' : ''}.`;
}

/** Expand a schema into the { name, type, required, description, children } shape. */
function fieldsFrom(schema, depth, seenRefs) {
  const d = deref(schema, seenRefs);
  let s = d.schema;
  if (!s) return [];
  const refs = d.ref ? new Set([...seenRefs, d.ref]) : seenRefs;

  if (s.type === 'array') {
    const inner = deref(s.items, refs);
    if (inner.schema && inner.schema.properties) {
      return fieldsFrom(s.items, depth, inner.ref ? new Set([...refs, inner.ref]) : refs);
    }
    return [];
  }
  if (!s.properties) return [];

  const required = new Set(s.required || []);
  return Object.entries(s.properties).map(([name, prop]) => {
    const pd = deref(prop, refs);
    const ps = pd.schema;
    const field = {
      name,
      type: typeOf(prop.$ref ? { $ref: prop.$ref } : prop, pd.ref),
      required: required.has(name),
      description: clean((prop.description || (ps && ps.description) || '') + enumNote(prop.enum ? prop : ps)),
    };
    if (prop.readOnly) field.readOnly = true;

    if (depth < MAX_REQUEST_DEPTH && !pd.cyclic) {
      let childSource = null;
      if (prop.type === 'array' && prop.items) childSource = prop.items;
      else if (prop.$ref || (ps && ps.properties)) childSource = prop;
      if (childSource) {
        const kids = fieldsFrom(childSource, depth + 1, refs);
        if (kids.length) field.children = kids;
      }
    }
    return field;
  });
}

/** The view renders response fields as a flat table, so nesting becomes dotted names. */
function flatten(fields, prefix = '', depth = 0) {
  const out = [];
  for (const f of fields) {
    out.push({ name: prefix + f.name, type: f.type, description: f.description });
    if (f.children && depth < MAX_RESPONSE_FLATTEN) {
      out.push(...flatten(f.children, `${prefix}${f.name}[].`.replace('[].', f.type === 'array' ? '[].' : '.'), depth + 1));
    }
  }
  return out;
}

// ── existing coverage + group ownership ────────────────────────────────────
const covered = new Set();
const groupPaths = new Map(); // tag -> [normalised path segment arrays]
for (const g of existing) {
  groupPaths.set(g.tag, []);
  for (const op of g.operations) {
    covered.add(`${op.method.toUpperCase()} ${normPath(op.path)}`);
    groupPaths.get(g.tag).push(segs(op.path));
  }
}
const usedIds = new Set(existing.flatMap((g) => g.operations.map((o) => o.id)));

/**
 * Assign an operation to the hand-written group that owns the longest shared path prefix.
 *
 * A one-segment overlap only counts when it spans a whole documented path — i.e. the new
 * operation is a sub-resource of something that group already documents. Without that,
 * every /reports/* endpoint lands in VatReport (which documents /reports/vat/*) purely
 * because both start with "reports".
 */
function ownerTag(p) {
  const s = segs(p);
  let best = null;
  for (const [tag, paths] of groupPaths) {
    let len = 0, hits = 0;
    for (const q of paths) {
      let n = 0;
      while (n < s.length && n < q.length && s[n] === q[n]) n++;
      if (n === 0) continue;
      if (n < 2 && n !== q.length) continue;
      if (n > len) { len = n; hits = 1; } else if (n === len) hits++;
    }
    if (!len) continue;
    if (!best || len > best.len || (len === best.len && hits > best.hits)) best = { tag, len, hits };
  }
  return best ? best.tag : null;
}

// ── labels / styling for groups that have no hand-written counterpart ──────
/** First path segment -> sidebar group. Several segments deliberately share a group
 *  (all the /nextavailable*number endpoints become "Numbering"), and a segment may
 *  name a hand-written group in apiDocsConfig.js, which merges it there. */
const LABELS = {
  accountsummary: "Account Summary",
  alert: "Alerts",
  api: "API Metadata",
  metadata: "API Metadata",
  help: "Help Content",
  helpcontent: "Help Content",
  backup: "Backup",
  bankicons: "Icons",
  categoryicons: "Icons",
  branding: "Branding",
  categories: "Categories",
  companieshouse: "Companies House",
  copy: "Copy & Duplicate",
  duplicate: "Copy & Duplicate",
  customerstatements: "Customer Statements",
  customerstatementtransaction: "Customer Statements",
  supplierstatements: "Supplier Statements",
  supplierstatementtransaction: "Supplier Statements",
  dashboard: "Dashboard",
  dataimport: "Data Import",
  defaults: "Defaults",
  documents: "Documents",
  dropbox: "Dropbox",
  ecsl: "EC Sales List",
  email: "Email",
  emailoptions: "Email",
  emailtemplates: "Email",
  sendgridwebhook: "Email",
  mailtimeline: "Email",
  SMTPConfig: "Email",
  SMTPOAuth: "Email",
  smtpconfig: "Email",
  smtpoauth: "Email",
  viapost: "ViaPost",
  expenses: "Expenses",
  FeatureSwitch: "Feature Switches",
  FeatureValue: "Feature Switches",
  featureswitch: "Feature Switches",
  featurevalue: "Feature Switches",
  files: "Files",
  fixedassetregister: "Fixed Asset Register",
  gocardless: "GoCardless",
  iap: "Account & Subscription",
  partners: "Account & Subscription",
  referral: "Account & Subscription",
  signups: "Account & Subscription",
  subscription: "Account & Subscription",
  invoicecountforsubscriptioncycle: "Account & Subscription",
  purchasescountforsubscriptioncycle: "Account & Subscription",
  oneOff: "Account & Subscription",
  oneoff: "Account & Subscription",
  integration: "Integrations",
  integrations: "Integrations",
  internal: "Internal",
  InvoicePayment: "Invoice",
  PurchasePayment: "Purchases",
  irisoauth: "SSO & OAuth",
  okta: "SSO & OAuth",
  oauthsigneduri: "SSO & OAuth",
  itsa: "ITSA (Making Tax Digital)",
  jobs: "Jobs",
  jserror: "Client Errors",
  customerlist: "Customer",
  invoicelist: "Invoice",
  projectlist: "Project",
  purchaselist: "Purchases",
  quotelist: "Quote",
  purchaseorderlist: "PurchaseOrder",
  journallist: "Journal",
  journaltemplatelist: "Journal",
  list: "Lists",
  losses: "Losses",
  matchingengine: "Matching Engine",
  mileage: "Mileage",
  nextavailableinvoicenumber: "Numbering",
  nextavailableprojectnumber: "Numbering",
  nextavailablepurchasenumber: "Numbering",
  nextavailablepurchaseordernumber: "Numbering",
  nextavailablequotenumber: "Numbering",
  ocr: "OCR",
  password: "Users & Permissions",
  roles: "Users & Permissions",
  users: "Users & Permissions",
  userpermissions: "Users & Permissions",
  "userpermissions-mobile": "Users & Permissions",
  permissionhierarchy: "Users & Permissions",
  paymentmethods: "Payments",
  paymentstatuses: "Payments",
  paymentprocessors: "Payments",
  payonline: "Payments",
  postcodes: "Postcodes",
  recurringbanktransaction: "Recurring Bank Transactions",
  recurringinvoices: "Recurring Invoices",
  recurringpurchases: "Recurring Purchases",
  reminderletters: "Reminder Letters",
  reports: "Reports",
  reportcache: "Reports",
  salesagent: "Sales Agents",
  search: "Search",
  sources: "Sources",
  stockoptions: "Stock",
  tax: "Tax",
  taxes: "Tax",
  vatrates: "VatSetting",
  "{}": "Bulk Payments",
  invoicepayment: "Invoice",
  purchasepayment: "Purchases",
  purchase: "Purchases",
  settings: "Settings",
};

/** Icon per invented group. Groups merged into hand-written ones keep their own. */
const ICONS = {
  "Account Summary": "bi-clipboard-data",
  "Account & Subscription": "bi-person-badge",
  Alerts: "bi-bell",
  "API Metadata": "bi-braces",
  Attachments: "bi-paperclip",
  Backup: "bi-hdd",
  Branding: "bi-palette",
  "Bulk Payments": "bi-stack",
  Categories: "bi-tags",
  "Client Errors": "bi-bug",
  "Companies House": "bi-building-check",
  "Copy & Duplicate": "bi-files",
  "Customer Statements": "bi-file-earmark-person",
  Dashboard: "bi-speedometer2",
  "Data Import": "bi-upload",
  Defaults: "bi-sliders2",
  Documents: "bi-file-earmark-richtext",
  Dropbox: "bi-dropbox",
  "EC Sales List": "bi-globe-europe-africa",
  Email: "bi-envelope",
  Expenses: "bi-wallet2",
  "Feature Switches": "bi-toggles",
  Files: "bi-folder2-open",
  "Fixed Asset Register": "bi-buildings",
  GoCardless: "bi-arrow-left-right",
  "Help Content": "bi-question-circle",
  Icons: "bi-image",
  Integrations: "bi-diagram-3",
  Internal: "bi-lock",
  "ITSA (Making Tax Digital)": "bi-bank2",
  Jobs: "bi-list-check",
  Lists: "bi-list-ul",
  Losses: "bi-graph-down-arrow",
  "Matching Engine": "bi-magic",
  Mileage: "bi-signpost-split",
  Numbering: "bi-123",
  OCR: "bi-eye",
  Payments: "bi-credit-card",
  Postcodes: "bi-geo-alt",
  "Recurring Bank Transactions": "bi-arrow-repeat",
  "Recurring Invoices": "bi-arrow-repeat",
  "Recurring Purchases": "bi-arrow-repeat",
  "Reminder Letters": "bi-envelope-exclamation",
  Reports: "bi-bar-chart",
  "Sales Agents": "bi-person-workspace",
  Search: "bi-search",
  Sources: "bi-signpost",
  "SSO & OAuth": "bi-key",
  Stock: "bi-box-seam",
  "Supplier Statements": "bi-file-earmark-spreadsheet",
  Tax: "bi-percent",
  "Users & Permissions": "bi-people",
  ViaPost: "bi-mailbox",
  Settings: "bi-gear-wide-connected",
};
const PALETTE = ['slate', 'zinc', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald',
  'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];

function labelFor(seg) {
  if (LABELS[seg]) return LABELS[seg];
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * Paths whose prefix match sends them to the wrong hand-written group.
 * Checked before ownerTag(); first match wins.
 */
const OVERRIDES = [
  // /{objectType}/{objectNumber}/notes is documented under Note; attachments are a different thing.
  [/^\/\{objectType\}\/\{[^}]*\}\/files?$/i, 'Attachments'],
  [/^\/\{objectType\}\/\{[^}]*\}\/emailtextsubstitutions$/i, 'Email'],
  // /internal/* is its own surface — WithholdingTaxDeduction only documents part of it.
  [/^\/internal\/\{objectType\}\//i, 'Internal'],
];
function overrideTag(p) {
  for (const [re, tag] of OVERRIDES) if (re.test(p)) return tag;
  return null;
}

// ── build ──────────────────────────────────────────────────────────────────
function slugId(method, p) {
  let base = `${normPath(p).replace(/\{\}/g, 'by').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${method.toLowerCase()}`;
  let id = base, n = 2;
  while (usedIds.has(id)) id = `${base}-${n++}`;
  usedIds.add(id);
  return id;
}

const DESTRUCTIVE = new Set([
  'PUT /bankaccounts/{}/transactionlist',
  'DELETE /bankaccounts/{}/transactionlist',
  'POST /bankaccounts/assign-transaction-to-new-entity',
]);

function buildOperation(method, p, op) {
  const params = op.parameters || [];
  const fields = [];

  for (const prm of params) {
    if (prm.in === 'header' || prm.in === 'formData') continue;
    if (prm.in === 'body') {
      const bodyFields = fieldsFrom(prm.schema, 1, new Set());
      if (bodyFields.length) {
        fields.push(...bodyFields);
      } else {
        const d = deref(prm.schema, new Set());
        fields.push({
          name: prm.name || 'body',
          type: typeOf(prm.schema, d.ref),
          required: prm.required === true,
          description: clean(`Request body.${d.ref ? ` KashFlow model: ${d.ref}.` : ''} ${prm.description || ''}`),
        });
      }
      continue;
    }
    fields.push({
      name: prm.name,
      type: typeOf(prm, null),
      required: prm.required === true,
      description: clean(`${prm.in === 'path' ? 'Path parameter.' : 'Query parameter.'} ${prm.description || ''}${enumNote(prm)}`),
    });
  }

  const responses = op.responses || {};
  const okCode = ['200', '201', '202', '204'].find((c) => responses[c]) || Object.keys(responses)[0];
  const ok = okCode ? responses[okCode] : null;
  let responseFields = [];
  if (ok && ok.schema) responseFields = flatten(fieldsFrom(ok.schema, 1, new Set()));

  const notes = [];
  if (op.operationId) notes.push(`Swagger operationId: ${clean(op.operationId, 120)}.`);
  if (DESTRUCTIVE.has(`${method.toUpperCase()} ${normPath(p)}`)) {
    notes.push('Destructive: this endpoint deletes the source bank transaction in KashFlow. hcs-sync deliberately ships no wrapper for it — do not add one.');
  } else if (method.toUpperCase() === 'DELETE') {
    notes.push('Destructive: removes data in KashFlow. hcs-app treats KashFlow as the system of record and does not call it.');
  }
  notes.push('Generated from the published KashFlow Swagger spec — not verified against a live call.');

  const truncated = [];
  const cap = (list, what) => {
    if (list.length <= MAX_TABLE_ROWS) return list;
    truncated.push(`${list.length - MAX_TABLE_ROWS} further ${what} fields`);
    return list.slice(0, MAX_TABLE_ROWS);
  };
  const cappedFields = cap(fields, 'request');
  responseFields = cap(responseFields, 'response');
  if (truncated.length) {
    notes.unshift(`Truncated here: ${truncated.join(' and ')}. See the full model in the Swagger spec.`);
  }

  const entry = {
    id: slugId(method, p),
    method: method.toUpperCase(),
    path: p,
    summary: clean(op.summary || op.operationId || `${method.toUpperCase()} ${p}`, 90),
    description: clean(op.description || op.summary || ''),
    generated: true,
  };
  if (cappedFields.length) entry.request = { fields: cappedFields };
  entry.response = {
    status: okCode ? Number(okCode) || okCode : 200,
    description: clean((ok && ok.description) || 'Response body as published by KashFlow.'),
    fields: responseFields,
  };
  entry.notes = notes;
  return entry;
}

const byTag = new Map();       // tag -> { meta, operations }
const newSegments = new Map(); // invented tag -> palette index
const existingOrderSet = new Set(existing.map((g) => g.tag));

for (const [p, ops] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = ops[method];
    if (!op) continue;
    if (covered.has(`${method.toUpperCase()} ${normPath(p)}`)) continue;

    const tag = overrideTag(p)
      || ownerTag(p)
      || labelFor(segs(p)[0] || 'misc');

    // Groups that exist by hand are merged by tag and keep their own styling.
    let meta = null;
    if (!existingOrderSet.has(tag)) {
      if (!newSegments.has(tag)) newSegments.set(tag, newSegments.size);
      const colour = PALETTE[newSegments.get(tag) % PALETTE.length];
      meta = {
        icon: ICONS[tag] || 'bi-plug',
        colorClass: `text-${colour}-700`,
        bgClass: `bg-${colour}-50`,
        borderClass: `border-${colour}-200`,
      };
    }
    if (!byTag.has(tag)) byTag.set(tag, { tag, meta, operations: [] });
    byTag.get(tag).operations.push(buildOperation(method, p, op));
  }
}

// stable ordering: groups that merge into hand-written ones first (in their order), then new ones A-Z
const existingOrder = existing.map((g) => g.tag);
const groups = [...byTag.values()].sort((a, b) => {
  const ai = existingOrder.indexOf(a.tag), bi = existingOrder.indexOf(b.tag);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.tag.localeCompare(b.tag);
});
for (const g of groups) g.operations.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

// ── report ─────────────────────────────────────────────────────────────────
const total = groups.reduce((n, g) => n + g.operations.length, 0);
console.log(`generated ${total} operations in ${groups.length} groups`);
console.log(`  merged into hand-written groups: ${groups.filter((g) => !g.meta).length}`);
console.log(`  brand-new groups: ${groups.filter((g) => g.meta).length}`);
if (process.env.SHOW_GROUPS) {
  for (const g of groups) console.log(`   ${g.meta ? '+' : '→'} ${g.tag.padEnd(34)} ${g.operations.length}`);
}
if (process.env.DUMP_ASSIGN) {
  fs.writeFileSync(process.env.DUMP_ASSIGN, JSON.stringify(
    groups.map((g) => ({ tag: g.tag, isNew: !!g.meta, ops: g.operations.map((o) => `${o.method} ${o.path}`) })), null, 1));
}
if (DRY) process.exit(0);

// ── emit ───────────────────────────────────────────────────────────────────
function lit(v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => `${pad}  ${lit(x, indent + 2)}`).join(',\n')},\n${pad}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return `{\n${keys.map((k) => `${pad}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${lit(v[k], indent + 2)}`).join(',\n')},\n${pad}}`;
  }
  return JSON.stringify(v);
}

const header = `/**
 * Machine-generated KashFlow API reference — DO NOT EDIT BY HAND.
 *
 * Source:    ${SPEC_URL}  (Swagger 2.0, readable without auth)
 * Generated: ${new Date().toISOString().slice(0, 10)}
 * Regenerate with scripts/generate-api-docs.mjs.
 *
 * Contains only the operations NOT documented by hand in apiDocsConfig.js
 * (${existing.reduce((n, g) => n + g.operations.length, 0)} hand-written, ${total} generated here). Every operation carries
 * \`generated: true\` so the page can distinguish curated prose from spec-derived text.
 *
 * Groups whose \`tag\` matches a hand-written group are MERGED into it by
 * apiDocsConfig.js and their styling fields are omitted; the rest stand alone.
 *
 * Shape matches apiDocsConfig.js — see the header there. Two constraints come
 * from the renderer (mongoose/controllers/helpController.js):
 *   - request field nesting stops at depth ${MAX_REQUEST_DEPTH}, because renderFieldTableHtml
 *     indents with \`pl-\${depth * 4}\` and deeper Tailwind classes are not in the build;
 *   - response fields are rendered FLAT, so nested response properties are
 *     flattened here into dotted names rather than \`children\`.
 * Descriptions are stripped of HTML: renderFieldTableHtml interpolates them unescaped.
 */

const apiDocsGenerated = ${lit(groups.map((g) => (g.meta ? { tag: g.tag, ...g.meta, generated: true, operations: g.operations } : { tag: g.tag, generated: true, operations: g.operations })), 0)};

export default apiDocsGenerated;
`;

fs.writeFileSync(OUT, header);
console.log(`wrote ${OUT} (${header.split('\n').length} lines)`);
