import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

import webContentConfig from '../mongoose/config/webContentConfig.js';

/**
 * Renders every website-editor view with full and minimal data.
 *
 * These views are generic over webContentConfig, which is the reason to render
 * them per type rather than once: a field type added to the config with no
 * branch in _field.ejs renders as nothing at all — a form that silently drops
 * whatever someone typed into it — and only a render across every declared
 * field would catch that.
 *
 * The CSP assertions are the same set bankViews.test.js makes: Helmet blocks
 * inline scripts and handlers at runtime, so a violation shows up as a quietly
 * broken page rather than an error.
 */

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mongoose/views/tailwindcss/website');

const MEDIA = [
  { uuid: 'm1', filename: 'fence-complete-5.webp', mime: 'image/webp', width: 1600, height: 1067, size: 210000, alt: 'Completed fencing' },
  { uuid: 'm2', filename: 'fence-before.webp', mime: 'image/webp', width: 1600, height: 1067, size: 190000, alt: '' },
];

/** A record with every field populated, whatever the type. */
function fullRecord(cfg) {
  const record = { uuid: 'r-1', slug: 'a-slug', status: 'published', publishedAt: new Date('2026-03-05') };
  for (const field of cfg.fields) {
    switch (field.type) {
      case 'number': record[field.name] = 3; break;
      case 'date': record[field.name] = new Date('2027-01-31'); break;
      case 'tags': record[field.name] = ['news', 'company']; break;
      case 'image': record[field.name] = { media: 'm1', alt: 'Completed fencing' }; break;
      case 'panel': record[field.name] = { media: 'm2', alt: 'Damaged fencing', caption: 'Due for replacement.' }; break;
      case 'gallery': record[field.name] = [{ media: 'm1', alt: 'Panels going in', caption: '' }]; break;
      case 'hours': record[field.name] = [{ days: 'Monday – Friday', time: '8:00am – 5:00pm' }]; break;
      case 'offices': record[field.name] = [{ label: 'Liverpool office', phone: '0151 475 1217', address: { line1: '103 Herondale Road', line3: 'Liverpool', postcode: 'L18 1JZ' } }]; break;
      case 'richtext': record[field.name] = '<p>Some copy.</p>'; break;
      default: record[field.name] = 'A value';
    }
  }
  return record;
}

const render = (view, data) => ejs.renderFile(path.join(VIEWS, `${view}.ejs`), { csrfToken: 'tok', ...data });

function assertClean(html, what) {
  assert.ok(html.length > 50, `${what} rendered almost nothing`);
  assert.ok(!/<script/i.test(html), `${what} contains a <script> tag`);
  assert.ok(!/<style/i.test(html), `${what} contains a <style> tag`);
  assert.ok(!/\son(click|change|submit|load|input)\s*=/i.test(html), `${what} contains an inline event handler`);
  assert.ok(!/\b(fetch|XMLHttpRequest|axios)\s*\(/.test(html), `${what} makes a browser network call`);
  for (const tag of ['<html', '<head', '<body', '<nav']) {
    assert.ok(!html.toLowerCase().includes(tag), `${what} contains ${tag} — views are fragments`);
  }
}

describe('website editor views', () => {
  for (const [type, cfg] of Object.entries(webContentConfig)) {
    describe(`${type} form`, () => {
      it('renders a populated record', async () => {
        const html = await render('form', { type, cfg, record: fullRecord(cfg), media: MEDIA, title: 'T' });
        assertClean(html, `${type} form (full)`);
      });

      it('renders an empty create form', async () => {
        const html = await render('form', { type, cfg, record: null, media: MEDIA, title: 'T' });
        assertClean(html, `${type} form (create)`);
      });

      it('renders with no media in the library', async () => {
        // The first person to use this has an empty library, and the pickers
        // must still render rather than throwing on an empty list.
        const html = await render('form', { type, cfg, record: null, media: [], title: 'T' });
        assertClean(html, `${type} form (no media)`);
      });

      it('renders an input for every declared field', async () => {
        const html = await render('form', { type, cfg, record: fullRecord(cfg), media: MEDIA, title: 'T' });
        for (const field of cfg.fields) {
          assert.ok(
            html.includes(`name="${field.name}"`) || html.includes(`name="${field.name}[`),
            `${type}: field "${field.name}" (${field.type}) has no input — the form would drop it silently`,
          );
        }
      });

      it('includes a CSRF token in every form', async () => {
        const html = await render('form', { type, cfg, record: fullRecord(cfg), media: MEDIA, title: 'T' });
        const forms = html.match(/<form[^>]*method="POST"/gi) || [];
        const tokens = html.match(/name="_csrf"/g) || [];
        assert.ok(forms.length > 0, 'no POST form rendered');
        assert.equal(tokens.length, forms.length, 'a POST form is missing its CSRF token');
      });
    });

    if (!cfg.singleton) {
      describe(`${type} list`, () => {
        const records = [
          { uuid: 'r-1', slug: 'a', status: 'published', title: 'A study', name: 'A body', client: 'Plus Dane' },
          { uuid: 'r-2', slug: 'b', status: 'draft', title: 'A draft', name: 'A draft' },
        ];

        it('renders rows', async () => {
          const html = await render('list', { type, cfg, records, titleField: 'title', title: 'T' });
          assertClean(html, `${type} list`);
        });

        it('renders empty', async () => {
          const html = await render('list', { type, cfg, records: [], titleField: 'title', title: 'T' });
          assertClean(html, `${type} list (empty)`);
        });

        it('distinguishes live from draft', async () => {
          const html = await render('list', { type, cfg, records, titleField: 'title', title: 'T' });
          assert.match(html, /Live/, 'published records are not marked live');
          assert.match(html, /Draft/, 'draft records are not marked draft');
        });
      });
    }
  }

  describe('media library', () => {
    it('renders with images', async () => {
      const html = await render('media', { media: MEDIA, maxBytes: 307200, title: 'M' });
      assertClean(html, 'media library');
    });

    it('renders empty', async () => {
      const html = await render('media', { media: [], maxBytes: 307200, title: 'M' });
      assertClean(html, 'media library (empty)');
    });

    it('flags an image with no alt text', async () => {
      // The brief is explicit that alt text is real content, not decoration.
      const html = await render('media', { media: MEDIA, maxBytes: 307200, title: 'M' });
      assert.match(html, /No alt text/);
    });

    it('posts as multipart', async () => {
      const html = await render('media', { media: [], maxBytes: 307200, title: 'M' });
      assert.match(html, /enctype="multipart\/form-data"/);
    });
  });
});
