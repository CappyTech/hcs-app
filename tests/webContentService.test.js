import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import mdb from '../mongoose/services/mongooseDatabaseService.js';
import webContentConfig from '../mongoose/config/webContentConfig.js';
import { buildPayload, payloadEtag, slugify } from '../services/webContentService.js';

/**
 * The payload hcs-web mirrors and serves the public site from.
 *
 * The assertion that matters is the first one: the published filter is applied
 * in the query, once, for every collection. If a draft ever reaches this
 * payload it reaches heroncs.co.uk, and it stays there in hcs-web's disk cache
 * even after the mistake is corrected here — the mirror is only refreshed by a
 * later successful pull.
 */

// What each mocked collection was queried with, so the filter can be asserted
// rather than inferred from the rows a stub chose to return.
let queries = [];

function chain(rows) {
  return {
    sort: mock.fn(() => ({ lean: mock.fn(async () => rows) })),
    select: mock.fn(() => ({ sort: mock.fn(() => ({ lean: mock.fn(async () => rows) })) })),
    lean: mock.fn(async () => rows),
  };
}

function collection(rows) {
  return {
    find: mock.fn((q) => { queries.push(q); return chain(rows); }),
    findOne: mock.fn((q) => { queries.push(q); return chain(rows[0] || null); }),
  };
}

function patchWeb({
  site = null, services = [], accreditations = [], posts = [], studies = [], media = [],
} = {}) {
  queries = [];
  mdb.WEB = {
    ...mdb.WEB,
    webSiteSettings: collection(site ? [site] : []),
    webService: collection(services),
    webAccreditation: collection(accreditations),
    webPost: collection(posts),
    webCaseStudy: collection(studies),
    webMedia: collection(media),
  };
}

describe('webContentService.buildPayload', () => {
  beforeEach(() => patchWeb());

  it('filters every collection on published, in the query', async () => {
    await buildPayload();
    assert.equal(queries.length, 6, 'expected one query per collection');
    for (const q of queries) {
      assert.deepEqual(q, { status: 'published' }, 'a collection was read without the published filter');
    }
  });

  it('returns an entry for every content type', async () => {
    const payload = await buildPayload();
    for (const key of ['site', 'services', 'accreditations', 'posts', 'studies', 'media']) {
      assert.ok(key in payload, `payload is missing ${key}`);
    }
  });

  it('never includes image bytes in the manifest', async () => {
    // The bytes are fetched per-uuid. Inlining them would put megabytes on the
    // wire on every poll to answer "nothing changed".
    patchWeb({ media: [{ uuid: 'm1', filename: 'fence.webp', mime: 'image/webp', size: 1, hash: 'h' }] });
    const payload = await buildPayload();
    assert.equal(payload.media.length, 1);
    assert.ok(!('bytes' in payload.media[0]), 'the manifest carries image bytes');
  });

  it('renders a case study in the shape hcs-web already expects', async () => {
    patchWeb({
      studies: [{
        slug: 'estate-fencing-replacement',
        title: 'Estate fencing replacement',
        client: '',
        location: 'Merseyside',
        excerpt: 'Aging boundary fencing replaced.',
        card: { media: 'm1', alt: 'Completed fencing' },
        before: { media: 'm2', alt: 'Damaged fencing', caption: 'Due for replacement.' },
        after: { media: 'm1', alt: 'New fencing', caption: 'Clean, level, usable.' },
        gallery: [{ media: 'm3', alt: 'Panels going in', caption: '' }],
        contentHtml: '<p>Full write-up.</p>',
        socialValue: null,
      }],
    });
    const [study] = (await buildPayload()).studies;
    assert.equal(study.slug, 'estate-fencing-replacement');
    assert.equal(study.client, '', 'an unnamed client must stay blank, not become a placeholder');
    assert.deepEqual(study.card, { media: 'm1', alt: 'Completed fencing' });
    assert.equal(study.before.caption, 'Due for replacement.');
    assert.equal(study.gallery.length, 1);
    // hcs-web's views read `content`, not `contentHtml`.
    assert.equal(study.content, '<p>Full write-up.</p>');
  });

  it('drops gallery rows and panels with no image', async () => {
    // The form renders blank spare rows; they must not reach the site as holes.
    patchWeb({
      studies: [{
        slug: 's', title: 'T',
        before: { media: '', alt: '', caption: '' },
        gallery: [{ media: 'm1', alt: 'a' }, { media: '', alt: '' }],
      }],
    });
    const [study] = (await buildPayload()).studies;
    assert.equal(study.before, null);
    assert.equal(study.gallery.length, 1);
  });

  it('returns a null site rather than throwing when settings are unpublished', async () => {
    // hcs-web falls back to its own seed data on a null; a throw here would
    // fail the whole pull and freeze the mirror on a stale copy instead.
    const payload = await buildPayload();
    assert.equal(payload.site, null);
  });
});

describe('webContentService.payloadEtag', () => {
  it('ignores generatedAt', () => {
    // Hashing it would make every poll a 200 with a full body, and the 304
    // path — the entire point of the ETag — would never fire.
    const a = { generatedAt: '2026-01-01T00:00:00.000Z', posts: [{ slug: 'x' }] };
    const b = { generatedAt: '2026-08-18T09:30:00.000Z', posts: [{ slug: 'x' }] };
    assert.equal(payloadEtag(a), payloadEtag(b));
  });

  it('changes when the content changes', () => {
    const a = { generatedAt: 'z', posts: [{ slug: 'x' }] };
    const b = { generatedAt: 'z', posts: [{ slug: 'y' }] };
    assert.notEqual(payloadEtag(a), payloadEtag(b));
  });

  it('is a quoted ETag value', () => {
    assert.match(payloadEtag({ generatedAt: 'z' }), /^"[a-f0-9]{32}"$/);
  });
});

describe('webContentService.slugify', () => {
  it('produces the slugs already in use on the live site', () => {
    assert.equal(slugify('Estate fencing replacement'), 'estate-fencing-replacement');
    assert.equal(slugify('Social value: our Jobs Plus partnership'), 'social-value-our-jobs-plus-partnership');
  });

  it('strips accents and punctuation rather than percent-encoding them', () => {
    assert.equal(slugify('Café & Co.'), 'cafe-co');
  });

  it('never returns leading or trailing hyphens', () => {
    assert.equal(slugify('  --Fencing--  '), 'fencing');
  });
});

describe('webContentConfig', () => {
  it('declares at most one richtext field per type', () => {
    // layout.ejs binds Quill to hardcoded element ids, so a second editor on a
    // page would silently write into the first one's hidden input and one of
    // the two fields would save empty.
    for (const [type, cfg] of Object.entries(webContentConfig)) {
      const rich = cfg.fields.filter((f) => f.type === 'richtext');
      assert.ok(rich.length <= 1, `${type} declares ${rich.length} richtext fields`);
    }
  });

  it('never declares status or publishedAt as an editable field', () => {
    // fields[] is the write whitelist. Declaring status here would let a form
    // publish a record, bypassing the deliberate publish route.
    for (const [type, cfg] of Object.entries(webContentConfig)) {
      for (const forbidden of ['status', 'publishedAt', 'uuid', 'createdBy', 'updatedBy']) {
        assert.ok(
          !cfg.fields.some((f) => f.name === forbidden),
          `${type} exposes ${forbidden} to the form`,
        );
      }
    }
  });

  it('names a model and a label for every type', () => {
    for (const [type, cfg] of Object.entries(webContentConfig)) {
      assert.ok(cfg.model, `${type} has no model`);
      assert.ok(cfg.label, `${type} has no label`);
      assert.ok(Array.isArray(cfg.fields) && cfg.fields.length, `${type} has no fields`);
    }
  });
});
