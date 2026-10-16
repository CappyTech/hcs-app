import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import ejs from 'ejs';

import nav from '../services/navigationService.js';
import navPreference from '../mongoose/services/navPreferenceService.js';
import departmentsConfig from '../mongoose/config/departmentsConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';
import dateService from '../services/dateService.js';

/**
 * The five header styles (partials/nav/*.ejs) rendered as the layout renders
 * them. There is no browser here, so "desktop and phone" is checked through
 * the markup each width relies on: the horizontal-scroll rows, the md:hidden
 * menu button, the lg:hidden drawer toggle and its translate classes.
 */

const VIEWS = path.resolve('mongoose/views/tailwindcss');
const NAV = path.join(VIEWS, 'partials', 'nav');
const STYLES = nav.STYLES;

const user = { _id: 'u-1', role: 'admin', customPermissions: {} };
const locals = (navStyle, reqPath = '/finance/invoices', who = user) => ({
  isAuthenticated: true,
  navStyle,
  nav: nav.build({ path: reqPath, user: who }),
  title: 'Invoices',
  firstName: 'Test',
  companyName: 'Example Co',
  companyShortName: 'Example',
  csrfToken: 't',
  cspNonce: 'n',
  flash: { success: [], error: [] },
  body: '<p id="page-body">page</p>',
  package: '0.0.0',
  commit: null,
  commitUrl: null,
  copyrightyearstart: 2020,
  copyrightyear: 2026,
  lastfetched: null,
  slimDateTime: dateService.slimDateTime,
  maintenanceActive: false,
  maintenanceNotice: '',
});

const renderPartial = (style, l) => ejs.renderFile(path.join(NAV, `${style}.ejs`), l, { async: false });
const renderLayout = (l) => ejs.renderFile(path.join(VIEWS, 'layout.ejs'), l, { async: false });

const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const currents = (html) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);

describe('every nav style', () => {
  for (const style of STYLES) {
    describe(style, () => {
      it('reaches every department link this person may open, plus Home and Help', async () => {
        const l = locals(style);
        const html = await renderPartial(style, l);
        const links = hrefs(html);
        for (const item of l.nav.items) assert.ok(links.includes(item.href), `${style} links to ${item.href}`);
        assert.ok(links.includes('/'), 'Home');
        assert.ok(links.includes('/help'), 'Help');
        assert.match(html, /id="theme-toggle"/);
        assert.match(html, /id="theme-icon"/);
        assert.equal((html.match(/id="theme-toggle"/g) || []).length, 1, 'one theme toggle for theme-toggle.js');
      });

      it('marks the active item with aria-current and nothing else', async () => {
        const html = await renderPartial(style, locals(style, '/finance/invoices'));
        const c = currents(html);
        assert.ok(c.includes('/finance'), `${style} marks /finance active`);
        assert.ok(c.every((h) => h === '/finance'), `only /finance is current, got ${c.join(', ')}`);
        const home = await renderPartial(style, locals(style, '/'));
        assert.ok(currents(home).every((h) => h === '/'), 'only Home is current on /');
      });

      it('renders for an employee with their smaller set, and for nobody-shaped locals', async () => {
        const employee = { _id: 'u-2', role: 'employee', customPermissions: {} };
        const html = await renderPartial(style, locals(style, '/attendance', employee));
        assert.ok(hrefs(html).includes('/attendance'));
        assert.ok(!hrefs(html).includes('/admin'));
        // A page that errors before the nav is built still gets a header
        const bare = await renderPartial(style, { ...locals(style), nav: undefined });
        assert.match(bare, /id="theme-toggle"/);
      });

      it('has no inline script or event attributes (strict CSP)', async () => {
        const html = await renderPartial(style, locals(style));
        assert.ok(!/<script/i.test(html));
        assert.ok(!/\son[a-z]+=/i.test(html));
      });

      it('is what layout.ejs includes, with the main area padded for it', async () => {
        const html = await renderLayout(locals(style));
        assert.match(html, new RegExp(`data-nav-style="${style}"`));
        assert.match(html, /id="page-body"/);
        const main = html.match(/<main id="main-content" class="([^"]+)"/)[1];
        if (style === 'two-tier') assert.match(main, /\bpt-24\b/);
        else assert.match(main, /\bpt-16\b/);
        if (style === 'sidebar') assert.match(main, /lg:pl-\[232px\]/);
        else assert.ok(!/lg:pl-/.test(main));
      });
    });
  }

  it('falls back to tabs for an unknown style and shows no header when signed out', async () => {
    const html = await renderLayout({ ...locals('carousel') });
    assert.match(html, /data-nav-style="tabs"/);
    const out = await renderLayout({ ...locals('sidebar'), isAuthenticated: false, nav: nav.build({ path: '/', user: null }) });
    assert.ok(!/data-nav-style=/.test(out));
    assert.match(out, /pt-16/);
  });
});

describe('tabs is pixel-identical to the old inline header', () => {
  it('renders the same markup as the legacy layout block for every role', async () => {
    const legacy = fs.readFileSync(path.resolve('tests/fixtures/nav-tabs-legacy.ejs'), 'utf8');
    const normalise = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/\s*>\s*/g, '>').replace(/\s*<\s*/g, '<').trim();
    for (const role of ['admin', 'accountant', 'employee', 'subcontractor', 'hmrc', 'client', 'auditor']) {
      for (const reqPath of ['/', '/finance/invoices', '/help', '/create', '/attendance']) {
        const who = { _id: 'u', role, customPermissions: {} };
        const old = ejs.render(legacy, {
          departmentsConfig,
          canDept: (slug) => rbac.canAccessDepartment(role, slug, {}),
          navActive: (href) => nav.isActive(reqPath, href),
        });
        const now = await renderPartial('tabs', locals('tabs', reqPath, who));
        assert.equal(normalise(now).replace(' data-nav-style="tabs"', ''), normalise(old), `${role} at ${reqPath}`);
      }
    }
  });
});

describe('phone and desktop markup', () => {
  it('tabs and two-tier scroll horizontally with labels visible', async () => {
    const tabs = await renderPartial('tabs', locals('tabs'));
    assert.match(tabs, /overflow-x-auto/);
    assert.ok(!/hidden sm:inline/.test(tabs), 'labels are never hidden');
    const two = await renderPartial('two-tier', locals('two-tier'));
    assert.match(two, /overflow-x-auto/);
    const row = two.match(/aria-label="Areas"[\s\S]*$/)[0];
    for (const item of locals('two-tier').nav.items.filter((i) => i.special !== 'create' && i.slug !== 'user')) {
      assert.match(row, new RegExp(`<span>${item.label}</span>`));
    }
  });

  it('grouped has one menu per group on desktop and a single menu button on a phone', async () => {
    const l = locals('grouped');
    const html = await renderPartial('grouped', l);
    for (const g of l.nav.groups) assert.match(html, new RegExp(`id="nav-menu-${g.key}"[^>]*aria-expanded="false"`));
    assert.match(html, /class="relative md:hidden"/);
    assert.match(html, /id="nav-menu-all"/);
    assert.match(html, /hidden md:flex/);
    assert.match(html, /x-data="navMenu"/);
    // Every grouped link is in a menu panel with role=menu
    assert.ok((html.match(/role="menu"/g) || []).length >= l.nav.groups.length + 1);
  });

  it('command pins the defaults as chips, groups the rest under More, and centres Jump to', async () => {
    const l = locals('command');
    const html = await renderPartial('command', l);
    const rail = html.match(/aria-label="Pinned areas"[\s\S]*?<\/div>/)[0];
    for (const p of l.nav.pinned) assert.match(rail, new RegExp(`href="${p.href}"`));
    assert.match(html, /id="nav-menu-more"/);
    for (const g of l.nav.more) assert.match(html, new RegExp(`>${g.label}<`));
    assert.match(html, /id="nav-jump"/);
    assert.match(html, /Ctrl K/);
    assert.match(html, /x-data="navJump"/);
  });

  it('sidebar is fixed on lg+ and a drawer below, with Jump to and a More fold for System', async () => {
    const html = await renderPartial('sidebar', locals('sidebar'));
    assert.match(html, /id="nav-drawer-toggle"[^>]*aria-expanded="false"/);
    assert.match(html, /lg:hidden/);
    assert.match(html, /-translate-x-full lg:translate-x-0/);
    assert.match(html, /w-\[232px\]/);
    assert.match(html, /<details[^>]*>/);
    assert.match(html, /href="\/admin"/);
    assert.match(html, /id="nav-jump"/);
  });

  it('Jump to lists every reachable link for client-side filtering', async () => {
    for (const style of ['grouped', 'two-tier', 'command', 'sidebar']) {
      const l = locals(style);
      const html = await renderPartial(style, l);
      const list = html.match(/<ul id="nav-jump-results"[\s\S]*?<\/ul>/)[0];
      for (const item of l.nav.items) assert.match(list, new RegExp(`data-jump-text="[^"]*${item.label.toLowerCase()}[^"]*"[\\s\\S]*?href="${item.href}"`), `${style}: ${item.label}`);
      assert.match(list, /data-jump-empty/);
    }
  });
});

describe('account settings navigation section', () => {
  it('offers a radio per style with a description and posts to /user/account/navigation', async () => {
    const l = locals('tabs', '/user/account');
    const html = await ejs.renderFile(path.join(VIEWS, 'user', 'account.ejs'), {
      ...l,
      user: { username: 'test.person', email: 'test@example.com', role: 'admin', totpEnabled: true },
      sessions: [],
      qrCodeUrl: '',
      secret: '',
      twoFARequired: false,
      navStyles: navPreference.STYLES,
      navPreference: { style: 'command', pinned: ['finance'], source: 'user' },
      navCompanyDefault: 'tabs',
    }, { async: false });
    assert.match(html, /action="\/user\/account\/navigation"/);
    for (const s of navPreference.STYLES) {
      assert.match(html, new RegExp(`name="navStyle" value="${s.value}"`));
      assert.match(html, new RegExp(s.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(html, /value="command" checked/);
    assert.match(html, /name="pinned" value="finance" checked/);
    assert.match(html, /name="pinned" value="admin"\s+class/);
    assert.match(html, /formaction="\/user\/account\/navigation\/reset"/);
  });
});
