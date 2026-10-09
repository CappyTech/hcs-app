import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import homeLayout from '../mongoose/services/homeLayoutService.js';

const as = (role, id = `u-${role}`) => ({ user: { _id: id, role, customPermissions: {} }, query: {} });
const admin = as('admin');

// In-memory homeLayout store plus count-only models for figures and lists
let docs = [];
function storeModel() {
  const match = (q) => (d) => d.scope === q.scope && d.key === q.key;
  return {
    findOne: (q) => ({ lean: async () => docs.find(match(q)) || null }),
    findOneAndUpdate: async (q, update) => {
      const existing = docs.find(match(q));
      if (existing) Object.assign(existing, update.$set);
      else docs.push({ ...q, ...update.$set });
    },
    deleteOne: async (q) => { docs = docs.filter((d) => !match(q)(d)); },
  };
}
function countModel(count, rows = []) {
  const chain = { sort: () => chain, limit: () => chain, select: () => chain, lean: async () => rows };
  return { find: () => chain, countDocuments: async () => count, aggregate: async () => [], distinct: async () => [] };
}

beforeEach(() => {
  docs = [];
  mdb.INTERNAL = {
    ...mdb.INTERNAL,
    homeLayout: storeModel(),
    employee: countModel(4, [{ uuid: 'e-1', name: 'Test Person', contract: { endDate: new Date('2026-01-01') } }]),
    task: countModel(2),
    user: countModel(1),
  };
});

describe('home layout options', () => {
  it('offers an admin every area, with figures and lists under them', () => {
    const groups = homeLayout.options(admin);
    const keys = homeLayout.allKeys(groups);
    assert.ok(keys.areas.has('human') && keys.areas.has('finance'));
    assert.ok(keys.figures.has('employee.contractsEndingSoon'));
    assert.ok(keys.lists.has('employee:list:contractsExpired'));
    assert.ok(keys.lists.has('leave:panel:upcomingHolidays'));
    // Panels with their own forms only belong on their overview
    assert.ok(![...keys.lists].some((k) => k.endsWith(':panel:projectFinancials')));
  });

  it('only offers a role what it may open', () => {
    const keys = homeLayout.allKeys(homeLayout.options(as('accountant')));
    assert.ok(keys.areas.has('finance'));
    assert.ok(!keys.areas.has('human'));
    assert.ok(![...keys.figures].some((k) => k.startsWith('employee.')));
    assert.equal(homeLayout.options(as('employee')).length, 0);
  });
});

describe('home layout form', () => {
  const allowed = homeLayout.allKeys(homeLayout.options(admin));

  it('keeps only allowed pins, ordered by the numbers given', () => {
    const layout = homeLayout.fromForm({
      pin: ['finance', 'human', 'employee.contractsEndingSoon', 'employee.nope', 'evil', 'employee:list:contractsExpired'],
      order: { finance: '2', human: '1' },
    }, allowed);
    assert.deepStrictEqual(layout, {
      areas: ['human', 'finance'],
      figures: ['employee.contractsEndingSoon'],
      lists: ['employee:list:contractsExpired'],
    });
  });

  it('accepts a single checkbox, blanks keep form order, and caps each kind', () => {
    assert.deepStrictEqual(homeLayout.fromForm({ pin: 'human' }, allowed).areas, ['human']);
    const figs = [...allowed.figures];
    const layout = homeLayout.fromForm({ pin: figs, order: { [figs[3]]: '0' } }, allowed);
    assert.equal(layout.figures[0], figs[3]);
    assert.equal(layout.figures.length, Math.min(figs.length, homeLayout.LIMITS.figures));
  });
});

describe('home layout resolution and drawing', () => {
  it('falls back from your own layout, to your role, to every area you may open', async () => {
    const req = as('admin', 'u-1');
    assert.equal((await homeLayout.resolve(req)).source, 'default');
    await homeLayout.save('role', 'admin', { areas: ['finance'], figures: [], lists: [] });
    assert.deepStrictEqual((await homeLayout.resolve(req)).layout.areas, ['finance']);
    await homeLayout.save('user', 'u-1', { areas: ['human'], figures: [], lists: [] });
    const own = await homeLayout.resolve(req);
    assert.equal(own.source, 'user');
    assert.deepStrictEqual(own.layout.areas, ['human']);
    await homeLayout.reset('user', 'u-1');
    assert.equal((await homeLayout.resolve(req)).source, 'role');
  });

  it('draws pinned tiles, figures and lists', async () => {
    await homeLayout.save('user', 'u-1', {
      areas: ['human', 'gone'], figures: ['employee.contractsEndingSoon', 'employee.gone'], lists: ['employee:list:contractsExpired', 'nope:list:x'],
    });
    const home = await homeLayout.build(as('admin', 'u-1'));
    assert.deepStrictEqual(home.tiles.map((t) => t.href), ['/overview/human']);
    assert.equal(home.figures.length, 1);
    assert.equal(home.figures[0].value, 4);
    assert.equal(home.figures[0].group, 'Employees');
    assert.equal(home.lists.length, 1);
    assert.ok(home.lists[0].rows.length <= 5);
  });

  it("never shows a pin the viewer couldn't open, even from a role default", async () => {
    await homeLayout.save('role', 'accountant', {
      areas: ['human', 'finance'], figures: ['employee.contractsEndingSoon'], lists: ['employee:list:contractsExpired'],
    });
    const home = await homeLayout.build(as('accountant'));
    assert.deepStrictEqual(home.tiles.map((t) => t.label), ['Finance']);
    assert.deepStrictEqual(home.figures, []);
    assert.deepStrictEqual(home.lists, []);
  });
});
