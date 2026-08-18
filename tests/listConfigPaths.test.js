import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import listConfig from '../mongoose/config/listControllerConfig.js';
import crudConfig from '../mongoose/config/CRUDControllerConfig.js';
import rbac from '../mongoose/config/rolePermissionsConfig.js';

/**
 * Surfacing one synced collection means four separate declarations agreeing,
 * and they do not share a key:
 *
 *   listRoutes.js      reads `pathOverride`  -> the ROUTE
 *   indexController.js reads `listPath`      -> the TILE LINK
 *   CRUDControllerConfig  middleware.read    -> who may open the route
 *   rolePermissionsConfig roleModelAccess    -> who is shown the tile
 *
 * Neither path key falls back to the other, and both default to a naive
 * `model + 's'`. So an irregular plural gives a tile pointing at `/countrys`
 * while the route is `/countries` — a dashboard link that 404s, with nothing
 * logged and no error anywhere. That is the class of fault these tests pin.
 */

const denied = (config, op) => Array.isArray(config.deny) && config.deny.includes(op);

// Mirrors the path computation in mongoose/routes/listRoutes.js.
const routePathFor = (model, config) => {
  if (config.pathOverride) {
    return config.pathOverride.startsWith('/') ? config.pathOverride : `/${config.pathOverride}`;
  }
  const routeModel = (config.modelRename || model).toLowerCase();
  const parts = routeModel.split('/').filter(Boolean);
  const last = parts.pop();
  return `/${[...parts, `${last}s`].join('/')}`;
};

// Mirrors the tile link computation in mongoose/controllers/indexController.js.
const tilePathFor = (model, config) => config.listPath || `/${model}s`;

// Every entry that earns a dashboard tile: it names a department and is listable.
const tiledEntries = Object.entries(listConfig)
  .filter(([, config]) => Array.isArray(config?.department) && config.department.length > 0)
  .filter(([, config]) => !denied(config, 'l'));

describe('list config route/tile agreement', () => {
  it('has tiled entries to check', () => {
    assert.ok(tiledEntries.length > 5, `expected several tiled entries, found ${tiledEntries.length}`);
  });

  for (const [model, config] of tiledEntries) {
    it(`${model}: the tile link and the route are the same path`, () => {
      const route = routePathFor(model, config);
      const tile = tilePathFor(model, config);
      assert.equal(
        tile, route,
        `tile links to ${tile} but the route is ${route} — set both listPath and pathOverride`,
      );
    });

    it(`${model}: the path is spelled identically, not just case-insensitively`, () => {
      // Express routing is case-insensitive by default, so a camelCase tile
      // against a lowercased route happens to work. Relying on a framework
      // default nobody set on purpose is how it stops working.
      const route = routePathFor(model, config);
      assert.equal(route, route.toLowerCase(), `${model} route ${route} is not lowercase`);
    });
  }
});

describe('KashFlow reference collections are readable by finance', () => {
  // These are mirrored hourly by hcs-sync and were read by nothing until they
  // were configured: no config meant no title, no department, and therefore no
  // tile — the pages existed for admins at URLs nothing linked to.
  const referenceModels = [
    'journal', 'vatReturn', 'accountingPeriod',
    'country', 'currency', 'quoteCategory', 'purchaseOrderCategory',
  ];

  for (const model of referenceModels) {
    it(`${model} is configured, read-only, and on the finance dashboard`, () => {
      const config = listConfig[model];
      assert.ok(config, `${model} has no listControllerConfig entry`);
      assert.ok(config.department?.includes('finance'), `${model} is not on the finance dashboard`);
      // KashFlow owns these. The write ops must stay denied, which is what
      // makes a plain 'r,l' grant the whole story.
      for (const op of ['c', 'u', 'd']) {
        assert.ok(denied(config, op), `${model} must deny '${op}' — KashFlow is the system of record`);
      }
    });

    it(`${model}: an accountant may list it and may not write it`, () => {
      assert.equal(rbac.canAccess('accountant', model, 'l').allowed, true, `${model} not listable by accountant`);
      assert.equal(rbac.canAccess('accountant', model, 'u').allowed, false, `${model} is writable by accountant`);
    });

    it(`${model}: the read middleware admits the accountant the tile is shown to`, () => {
      // Without an entry here the route falls back to the config default,
      // `ensureRole:admin` — so the accountant sees a tile and gets a 403.
      const read = crudConfig[model]?.middleware?.read;
      assert.ok(read, `${model} has no CRUDControllerConfig middleware.read`);
      assert.ok(
        read.some((m) => m.startsWith('ensureRoles:') && m.includes('accountant')),
        `${model} read middleware ${JSON.stringify(read)} excludes accountant`,
      );
    });
  }

  it('pins the column set, so a new KashFlow field cannot appear as a column', () => {
    // fieldOrder ORDERS columns; it does not restrict them. Anything not in
    // hideFields is appended after it, so a field KashFlow starts returning
    // (PVABoxTextChangeFrom did exactly this) arrives as an unannounced
    // column. strictOrder makes fieldOrder the definitive list.
    for (const model of referenceModels) {
      assert.equal(listConfig[model].strictOrder, true, `${model} does not set strictOrder`);
    }
  });

  it('vatReturn lists eight columns but shows the whole return on the detail page', () => {
    // Nine VAT box columns make the list unreadable, and Box 5 is the headline
    // figure. The full set lives in CRUDControllerConfig, which wins in
    // getMergedConfig — so narrowing the list must not narrow the detail page.
    const listOrder = listConfig.vatReturn.fieldOrder;
    const detailOrder = crudConfig.vatReturn.fieldOrder;
    assert.ok(detailOrder, 'vatReturn has no detail fieldOrder');
    assert.ok(listOrder.length < detailOrder.length, 'the list is not narrower than the detail page');
    assert.ok(listOrder.includes('Box5'), 'Box 5 is the net VAT payable and belongs in the list');
    for (const box of ['Box1', 'Box2', 'Box3', 'Box4', 'Box6', 'Box7', 'Box8', 'Box9']) {
      assert.ok(!listOrder.includes(box), `${box} should not be a list column`);
      assert.ok(detailOrder.includes(box), `${box} is missing from the detail page`);
    }
  });

  it('does not configure the two collections KashFlow returns empty', () => {
    // product and purchaseOrder sync 0 rows on every run; a tile would
    // advertise a permanently empty page. If KashFlow starts returning them,
    // configure them and delete this assertion — do not weaken it in place.
    for (const model of ['product', 'purchaseOrder']) {
      assert.equal(listConfig[model], undefined, `${model} is configured but syncs 0 rows`);
    }
  });
});
