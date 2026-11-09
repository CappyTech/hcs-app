import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPageList, listPages, matchPages, PAGE_LIMIT } from '../mongoose/services/pageSearchService.js';
import { createSearch } from '../mongoose/services/searchService.js';

/**
 * Search finds pages as well as records: a word that names a place in the app
 * lists the pages the person can open, and only those.
 */

const hrefs = (pages) => pages.map((p) => p.href);
const asRole = (role) => ({ user: { role, customPermissions: {} } });

describe('pageSearchService', () => {
  describe('real configuration', () => {
    it('finds the weekly attendance pages for a term that names no record', () => {
      const found = hrefs(matchPages(listPages(asRole('admin')), 'weekly'));
      assert.ok(found.includes('/overview/weekly'));
      assert.ok(found.includes('/weekly-flow'));
      assert.ok(found.includes('/weekly'));
    });

    it('lists only what the role can open', () => {
      const found = hrefs(matchPages(listPages(asRole('employee')), 'weekly'));
      assert.ok(found.includes('/weekly'));
      assert.ok(!found.includes('/weekly-flow'));
      assert.ok(!found.includes('/overview/weekly'));
      assert.ok(!found.includes('/weekly-management'));
    });

    it('lists nothing without a signed-in user', () => {
      assert.deepEqual(listPages({}), []);
    });

    it('lists each page once', () => {
      const all = hrefs(listPages(asRole('admin')));
      assert.equal(new Set(all).size, all.length);
    });
  });

  describe('createPageList', () => {
    const hierarchy = {
      listAreas: () => [{ id: 'a', path: '/overview/a', label: 'Area A', description: 'First', actions: [{ label: 'Do it', href: '/do', route: '/do' }] }],
      listNodes: () => [
        { id: 'n', label: { one: 'Node', many: 'Nodes' }, overview: {}, overviewPath: '/overview/n' },
        { id: 'h', label: 'Hidden', hidden: true, overview: {}, overviewPath: '/overview/h' },
        { id: 'l', label: 'List only', overviewPath: '/overview/l' },
      ],
    };
    const access = {
      rolesOf: (u) => [u.role],
      matchRoutePattern: (l) => (l === '/ruled' ? '/ruled' : null),
      canAccessRoute: () => false,
      canAccessDepartment: (roles, d) => d === 'ok',
    };
    const canOpen = (req, p) => p !== '/do';
    const req = asRole('employee');

    it('uses plural labels, skips hidden and overview-less nodes, and gates actions', () => {
      const pages = createPageList({ hierarchy, tileConfig: {}, access, canOpen })(req);
      assert.deepEqual(hrefs(pages), ['/overview/a', '/overview/n']);
      assert.equal(pages[1].title, 'Nodes');
    });

    it('gates tiles by route rule, else department, and skips outside or empty links', () => {
      const tileConfig = {
        ruled: { title: 'Ruled', link: '/ruled', department: ['ok'] },
        dept: { title: 'Dept', link: '/dept', department: ['ok'] },
        other: { title: 'Other', link: '/other', department: ['no'] },
        ext: { title: 'Ext', link: 'https://example.test', department: ['ok'] },
        none: { title: 'None', link: '', department: ['ok'] },
      };
      const none = { listAreas: () => [], listNodes: () => [] };
      assert.deepEqual(hrefs(createPageList({ hierarchy: none, tileConfig, access, canOpen })(req)), ['/dept']);
    });
  });

  describe('matchPages', () => {
    const pages = [
      { title: 'Projects', subtitle: 'Weekly assignments', href: '/p' },
      { title: 'Weekly attendance', subtitle: '', href: '/w' },
    ];

    it('ignores case and puts title matches first', () => {
      assert.deepEqual(hrefs(matchPages(pages, 'WEEKLY')), ['/w', '/p']);
    });

    it('treats the term as plain text and caps the group', () => {
      assert.deepEqual(matchPages(pages, '.*'), []);
      const many = Array.from({ length: PAGE_LIMIT + 3 }, (_, i) => ({ title: `Page ${i}`, subtitle: '', href: `/${i}` }));
      assert.equal(matchPages(many, 'page').length, PAGE_LIMIT);
    });
  });

  describe('in search', () => {
    const access = { canAccess: () => ({ allowed: false }), canAccessDepartment: () => false };
    const search = (pages) => createSearch({ db: {}, access, scopeQuery: async () => ({}), logger: { warn() {} }, entities: [], pages }).search;
    const req = asRole('admin');
    const page = { title: 'Weekly attendance', subtitle: '', href: '/w' };

    it('adds a Pages group ahead of the records', async () => {
      const { groups } = await search(() => [page])(req, 'weekly');
      assert.equal(groups[0].key, 'page');
      assert.deepEqual(groups[0].items, [page]);
    });

    it('leaves pages out of a search within one type', async () => {
      const { groups } = await search(() => [page])(req, 'weekly', { type: 'invoice' });
      assert.deepEqual(groups, []);
    });

    it('still answers when the page list fails', async () => {
      const { groups } = await search(() => { throw new Error('boom'); })(req, 'weekly');
      assert.deepEqual(groups, []);
    });
  });
});
