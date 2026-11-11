import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import ejs from 'ejs';
import jobRegisterModel from '../mongoose/models/mongoose/INTERNAL/jobRegister.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import accessGroups from '../mongoose/config/accessGroupsConfig.js';
import {
  stageOf, clientKey, taxYearOf, matchEntry, buildRegister, findUnregistered, nextNumber, parseEntryForm,
} from '../mongoose/services/jobRegisterService.js';
import { readFilters } from '../mongoose/controllers/jobRegisterController.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Entry = mongoose.models.jobRegisterTest || mongoose.model('jobRegisterTest', jobRegisterModel.schema.clone());
const d = (s) => new Date(`${s}T12:00:00Z`);

// Rows as on the Job Reg workbook: quote sheet numbers 51xxx, job sheet 41xxx
const entries = [
  { uuid: 'a', quoteNumber: 51425, quoteDate: d('2025-12-04'), projectNumber: 41158, jobDate: d('2025-12-16'), site: 'Maple House, Manchester', client: 'Rigby', contact: 'Derek Jackson', value: 750, description: 'Gully', invoiceNumber: 1622, invoiceDate: d('2026-02-10'), clientRef: '513' },
  { uuid: 'b', quoteNumber: 51437, quoteDate: d('2025-12-16'), site: '58/60/62 Cawdor St, Liverpool', client: 'Plus Dane', contact: 'Ian Garnett', value: 3244, description: 'Fencing' },
  { uuid: 'c', quoteNumber: 51766, quoteDate: d('2026-11-11'), site: '25 Platt Ave, Sandbach', client: 'Plus dane ', value: 7424, description: 'Paving' },
  { uuid: 'd', projectNumber: 41299, jobDate: d('2026-11-11'), site: '7 Jasmine Gardens, Warrington', client: 'Plus Dane', value: 600, description: 'Gravel', clientRef: '130984' },
  { uuid: 'e', quoteNumber: 51659, quoteDate: d('2026-08-01'), site: '61 Townfields, Sandbach', client: 'Plus Dane', description: 'Structural', cancelled: true },
];
const quotes = new Map([
  [51425, { uuid: 'q1', Number: 51425, CustomerName: 'Rigby', NetAmount: 750 }],
  [51437, { uuid: 'q2', Number: 51437, CustomerName: 'Plus Dane', NetAmount: 3000 }],
]);
const projects = new Map([
  [41158, { uuid: 'p1', Number: 41158, CustomerName: 'Rigby' }],
  [41299, { uuid: 'p2', Number: 41299, CustomerName: 'Plus Dane' }],
]);
const invoices = new Map([[1622, { uuid: 'i1', Number: 1622, CustomerName: 'Rigby', ProjectNumber: 41158 }]]);
const build = (filters) => buildRegister({ entries, quotesByNumber: quotes, projectsByNumber: projects, invoicesByNumber: invoices, filters });

describe('Job Register model', () => {
  it('needs a site, a client, and a quote or project number', async () => {
    await assert.rejects(() => new Entry({ site: 'X', client: 'Y' }).validate(), /quote number, a project number/);
    await assert.rejects(() => new Entry({ quoteNumber: 1, client: 'Y' }).validate(), /site/);
    await assert.rejects(() => new Entry({ quoteNumber: 1, site: 'X', client: 'Y', invoiceNumber: 5 }).validate(), /project number/);
    await new Entry({ quoteNumber: 51000, site: 'X', client: 'Y' }).validate();
    await new Entry({ projectNumber: 40011, site: 'Husco Maintenance', client: 'Husco' }).validate();
  });
});

describe('Job Register stages and matching', () => {
  it('works the stage out from the numbers', () => {
    assert.equal(stageOf(entries[1]), 'quoted');
    assert.equal(stageOf(entries[3]), 'won');
    assert.equal(stageOf(entries[0]), 'invoiced');
    assert.equal(stageOf(entries[4]), 'cancelled');
  });

  it('treats spellings of one client as one', () => {
    assert.equal(clientKey(' Plus  dane '), clientKey('Plus Dane'));
  });

  it('puts dates in UK tax years', () => {
    assert.equal(taxYearOf(d('2026-04-05')), 2025);
    assert.equal(taxYearOf(d('2026-04-06')), 2026);
  });

  it('ticks a row KashFlow agrees with, and names what differs', () => {
    const ok = matchEntry(entries[0], { quote: quotes.get(51425), project: projects.get(41158), invoice: invoices.get(1622) });
    assert.deepEqual([ok.quote.state, ok.project.state, ok.invoice.state], ['ok', 'ok', 'ok']);
    const off = matchEntry(entries[1], { quote: quotes.get(51437) });
    assert.equal(off.quote.state, 'differs');
    assert.match(off.quote.issues[0], /£3000\.00/);
    assert.equal(off.project.state, 'none');
    const missing = matchEntry(entries[2], {});
    assert.equal(missing.quote.state, 'missing');
    assert.ok(missing.missing);
    const wrongProject = matchEntry(entries[0], { invoice: { Number: 1622, ProjectNumber: 40000 } });
    assert.match(wrongProject.invoice.issues[0], /project 40000/);
  });
});

describe('Job Register filters', () => {
  it('counts every stage, and the double-entry checks leave cancelled rows out', () => {
    const r = build({});
    assert.equal(r.rows.length, 5);
    assert.deepEqual(
      { quoted: r.counts.quoted, won: r.counts.won, invoiced: r.counts.invoiced, cancelled: r.counts.cancelled },
      { quoted: 2, won: 1, invoiced: 1, cancelled: 1 },
    );
    assert.equal(r.counts.unmatched, 1); // 51766 isn't in KashFlow; cancelled 51659 isn't counted
    assert.equal(r.counts.differs, 1); // 51437's value
  });

  it('filters by stage, client, tax year and search', () => {
    assert.deepEqual(build({ stage: 'won' }).rows.map((r) => r.entry.uuid), ['d']);
    assert.deepEqual(build({ stage: 'unmatched' }).rows.map((r) => r.entry.uuid), ['c']);
    assert.deepEqual(build({ stage: 'differs' }).rows.map((r) => r.entry.uuid), ['b']);
    assert.equal(build({ client: 'plus dane' }).rows.length, 4);
    assert.deepEqual(build({ client: 'Rigby' }).rows.map((r) => r.entry.uuid), ['a']);
    assert.deepEqual(build({ year: 2025 }).rows.map((r) => r.entry.uuid).sort(), ['a', 'b']);
    assert.deepEqual(build({ q: 'cawdor' }).rows.map((r) => r.entry.uuid), ['b']);
  });

  it('lists clients once, by their most used spelling', () => {
    const plus = build({}).clients.find((c) => c.key === 'plus dane');
    assert.equal(plus.name, 'Plus Dane');
    assert.equal(plus.variants, 2);
  });

  it('totals the shown rows, leaving out cancelled', () => {
    const t = build({}).totals;
    assert.equal(t.value, 750 + 3244 + 7424 + 600);
    assert.equal(t.won, 600);
    assert.equal(t.invoiced, 750);
  });

  it('finds KashFlow quotes and projects with no register row', () => {
    const u = findUnregistered({
      quotes: [{ Number: 51425 }, { Number: 51800 }],
      projects: [{ Number: 41158 }, { Number: 41300 }],
      quoteNumbers: new Set([51425]),
      projectNumbers: new Set([41158]),
    });
    assert.deepEqual(u.quotes.map((q) => q.Number), [51800]);
    assert.deepEqual(u.projects.map((p) => p.Number), [41300]);
  });

  it('suggests the number after the highest in the register or KashFlow', () => {
    assert.equal(nextNumber([51766, 51700], [51770]), 51771);
    assert.equal(nextNumber([], []), null);
  });

  it('reads the year from the query string, and ignores junk', () => {
    assert.equal(readFilters({ year: '2026' }).year, 2026);
    assert.equal(readFilters({ year: 'x' }).year, null);
    assert.equal(readFilters({}).stage, 'all');
  });
});

describe('Job Register form', () => {
  it('reads numbers, money and dates, and blanks clear', () => {
    const f = parseEntryForm({ quoteNumber: '51766', value: '£7,424.00', quoteDate: '2026-11-11', projectNumber: '', site: ' 25 Platt Ave ', client: 'Plus Dane', cancelled: 'on' });
    assert.equal(f.quoteNumber, 51766);
    assert.equal(f.value, 7424);
    assert.equal(f.projectNumber, null);
    assert.equal(f.site, '25 Platt Ave');
    assert.equal(f.cancelled, true);
    assert.equal(f.quoteDate.toISOString().slice(0, 10), '2026-11-11');
  });

  it('refuses a bad number, value or date', () => {
    assert.throws(() => parseEntryForm({ quoteNumber: '51a' }), /quote number/);
    assert.throws(() => parseEntryForm({ value: '-3' }), /value/);
    assert.throws(() => parseEntryForm({ jobDate: '11/11/2026' }), /job date/);
  });
});

describe('Job Register access', () => {
  it('sits with Commercial, and the accountant can read it', () => {
    assert.ok(accessGroups.groups.commercial.models.includes('jobRegister'));
    assert.ok(accessGroups.groups.commercial.routes.view.includes('/job-register'));
    assert.ok(accessGroups.groups.finance.routes.view.includes('/job-register'));
    assert.deepEqual(rbac.routeAccess['/job-register'].filter((r) => ['admin', 'accountant'].includes(r)).sort(), ['accountant', 'admin']);
  });
});

describe('Job Register page', () => {
  const view = path.join(root, 'mongoose/views/tailwindcss/jobRegister/index.ejs');
  const base = {
    title: 'Job Register', csrfToken: 'c', crumbs: [], contracts: [{ uuid: 'k1', title: 'Windsor', status: 'In Progress' }],
    stageLabels: { quoted: 'Quoted', won: 'Won', invoiced: 'Invoiced', cancelled: 'Cancelled' },
    stages: ['quoted', 'won', 'invoiced', 'cancelled'], form: {},
    next: { quote: 51767, project: 41300 },
    unregistered: { year: 2026, quoteCount: 1, projectCount: 0, quotes: [{ uuid: 'q9', Number: 51800, Date: d('2026-11-01'), CustomerName: 'KMBC', NetAmount: 100 }], projects: [] },
  };

  it('shows the spreadsheet columns, the KashFlow checks and the add form', async () => {
    const html = await ejs.renderFile(view, { ...base, ...build({}) });
    for (const col of ['Quote', 'Job', 'Site', 'Client', 'Contact', 'Value', 'Desc.', 'Invoice', 'Inv. date', 'Client ref', 'KashFlow', 'Stage']) {
      assert.match(html, new RegExp(`>${col.replace('.', '\\.')}</th>`), col);
    }
    assert.match(html, /Maple House, Manchester/);
    assert.match(html, /Value in KashFlow is £3000\.00/);
    assert.match(html, /In KashFlow, not in the register/);
    assert.match(html, /51800/);
    assert.match(html, /Next quote number: <span class="font-mono">51767/);
    assert.match(html, /action="\/job-register"/);
    assert.match(html, /name="_csrf"/);
    assert.doesNotMatch(html, /<script/);
  });

  it('keeps the other filters on the stage chips', async () => {
    const html = await ejs.renderFile(view, { ...base, ...build({ client: 'rigby', year: 2025 }) });
    assert.match(html, /href="\/job-register\?stage=won&amp;client=rigby&amp;year=2025"/);
  });

  it('edit page shows each KashFlow side', async () => {
    const editView = path.join(root, 'mongoose/views/tailwindcss/jobRegister/edit.ejs');
    const r = build({});
    const row = r.rows.find((x) => x.entry.uuid === 'b');
    const html = await ejs.renderFile(editView, {
      ...base, title: 'Quote 51437', entry: row.entry, stage: row.stage, match: row.match, clients: r.clients,
    });
    assert.match(html, /In KashFlow but differs/);
    assert.match(html, /No number yet/);
    assert.match(html, /action="\/job-register\/b"/);
  });
});
