import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import brand from '../services/brandService.js';

const ENV_KEYS = ['BRAND_COLOUR', 'COMPANY_NAME', 'COMPANY_SHORT_NAME'];

describe('brandService', () => {
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    brand._resetForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  describe('colour', () => {
    it('defaults to green, which matches the built CSS', () => {
      assert.equal(brand.brandColour(), 'green');
      assert.match(brand.paletteCss(), /--brand-600: 22 163 74;/);
    });

    it('uses a configured palette', () => {
      process.env.BRAND_COLOUR = 'Indigo';
      assert.equal(brand.brandColour(), 'indigo');
      assert.equal(brand.themeColour(), '#4338ca');
      assert.match(brand.paletteCss(), /--brand-700: 67 56 202;/);
    });

    it('ignores a colour it does not offer', () => {
      for (const v of ['red', 'amber', '#ff0000', 'javascript:alert(1)']) {
        process.env.BRAND_COLOUR = v;
        assert.equal(brand.brandColour(), 'green', v);
      }
    });

    it('defines every shade for every palette', () => {
      for (const [name, shades] of Object.entries(brand.PALETTES)) {
        assert.equal(shades.length, brand.SHADES.length, name);
        for (const hex of shades) assert.match(hex, /^#[0-9a-f]{6}$/, `${name} ${hex}`);
        const css = brand.paletteCss(name);
        for (const s of brand.SHADES) assert.ok(css.includes(`--brand-${s}:`), `${name} lacks ${s}`);
      }
    });
  });

  describe('icon', () => {
    it('draws the generated mark at every served size without fonts', async () => {
      for (const size of brand.ICON_SIZES) {
        const meta = await sharp(await brand.iconPng(size)).metadata();
        assert.equal(meta.format, 'png');
        assert.equal(meta.width, size);
        assert.equal(meta.height, size);
      }
      assert.ok(!/<text/.test(brand.generatedIconSvg()), 'the Alpine image has no fonts');
    });

    it('refuses sizes it does not serve', async () => {
      await assert.rejects(() => brand.iconPng(999), RangeError);
    });

    it('changes the asset version with the colour', () => {
      const before = brand.assetVersion();
      process.env.BRAND_COLOUR = 'blue';
      assert.notEqual(brand.assetVersion(), before);
      assert.match(brand.iconUrl(192), /^\/brand\/icon-192\.png\?v=0-blue$/);
    });
  });

  describe('normaliseUpload', () => {
    it('re-encodes a raster image to a 512 square PNG', async () => {
      const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#f97316' } }).jpeg().toBuffer();
      const png = await brand.normaliseUpload(jpeg);
      const meta = await sharp(png).metadata();
      assert.equal(meta.format, 'png');
      assert.equal(meta.width, 512);
      assert.equal(meta.height, 512);
    });

    it('refuses SVG, even when it claims to be a PNG', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><script>alert(1)</script><rect width="512" height="512"/></svg>');
      await assert.rejects(() => brand.normaliseUpload(svg), /PNG, JPEG or WebP/);
    });

    it('refuses something that is not an image', async () => {
      await assert.rejects(() => brand.normaliseUpload(Buffer.from('not an image')), /not an image/);
      await assert.rejects(() => brand.normaliseUpload(Buffer.alloc(0)), /No image/);
    });

    it('refuses an image too small to be an icon', async () => {
      const tiny = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#000' } }).png().toBuffer();
      await assert.rejects(() => brand.normaliseUpload(tiny), /too small/);
    });
  });

  describe('manifest and offline page', () => {
    it('names the configured company', () => {
      process.env.COMPANY_NAME = 'Acme Groundworks Ltd';
      process.env.COMPANY_SHORT_NAME = 'Acme';
      const m = brand.manifest();
      assert.equal(m.name, 'Acme Groundworks Ltd');
      assert.equal(m.short_name, 'Acme');
      assert.equal(m.theme_color, brand.themeColour());
      assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
    });

    it('keeps the short name short enough for a home screen', () => {
      process.env.COMPANY_SHORT_NAME = 'A Very Long Company Short Name';
      assert.ok(brand.manifest().short_name.length <= 12);
    });

    it('escapes the company name into the offline page', () => {
      process.env.COMPANY_NAME = '<script>x</script> & Sons';
      const html = brand.offlineHtml();
      assert.ok(!html.includes('<script>x</script>'));
      assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt; &amp; Sons'));
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'every placeholder is filled');
    });
  });
});
