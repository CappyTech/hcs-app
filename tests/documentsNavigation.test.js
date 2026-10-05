import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import tiles from '../mongoose/config/dashboardTilesConfig.js';
import tileMeta from '../mongoose/config/dashboardTileMetaConfig.js';
import counts from '../mongoose/services/dashboardCountService.js';

/**
 * Every page the Paperless migration added can be reached by clicking, not
 * only by typing its address. Start points: the top-menu Documents dashboard,
 * the Documents overview, the queues, and a document's own page.
 */
const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
const TILES = tiles.default || tiles;

describe('Documents navigation', () => {
  it('the Documents dashboard has Document Queues and Shadow Report tiles', () => {
    const all = TILES.tiles || TILES;
    for (const [key, link] of [['DocumentQueues', '/paperless/queues'], ['ShadowReport', '/paperless/shadow-report']]) {
      const tile = all[key];
      assert.ok(tile, `${key} tile missing`);
      assert.equal(tile.link, link);
      assert.deepEqual(tile.department, ['documents']);
      assert.ok(tileMeta.iconFor(key) && tileMeta.iconFor(key) !== tileMeta.iconFor('__unknown__'), `${key} has its own icon`);
    }
    assert.equal(typeof counts.providers.DocumentQueues, 'function', 'queue tile shows how many are waiting');
  });

  it('every new page is linked from somewhere a user already goes', () => {
    const links = {
      '/paperless/queues': ['mongoose/views/tailwindcss/overview/documents.ejs'],
      '/paperless/shadow-report': ['mongoose/views/tailwindcss/overview/documents.ejs', 'mongoose/views/tailwindcss/paperless/queue.ejs'],
      '/entry': ['mongoose/views/tailwindcss/paperless/queue.ejs', 'mongoose/views/tailwindcss/paperless/read.ejs'],
    };
    for (const [href, files] of Object.entries(links)) {
      for (const f of files) assert.ok(read(f).includes(href), `${f} should link to ${href}`);
    }
    assert.match(read('mongoose/views/tailwindcss/paperless/queue.ejs'), /href="\/documents"[^>]*>← Documents/);
  });
});
