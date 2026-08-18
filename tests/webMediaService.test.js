import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { processImage, normaliseFilename, fileFilter, MAX_BYTES, MAX_EDGE } from '../services/webMediaService.js';

/**
 * The upload path for website photographs.
 *
 * Real sharp, no mocks: the assertions here are about what the encoder actually
 * produces — a size ceiling, a dimension ceiling, and EXIF being gone — and a
 * mocked encoder would assert only that the code calls the functions it calls.
 */

/** A noisy image, so the encoder cannot cheat the size limit on flat colour. */
async function noisyJpeg(width, height) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < px.length; i += 1) px[i] = (i * 2654435761) % 256;
  return sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

describe('webMediaService.processImage', () => {
  it('brings a large photograph under the brief\'s 300KB ceiling', async () => {
    const src = await noisyJpeg(3000, 2000);
    assert.ok(src.length > MAX_BYTES, 'the fixture is not large enough to be a real test');
    const out = await processImage(src, 'DSC_0001.JPG');
    assert.ok(out.size <= MAX_BYTES, `output is ${out.size} bytes, over the ${MAX_BYTES} ceiling`);
  });

  it('caps the longest edge without distorting the image', async () => {
    const out = await processImage(await noisyJpeg(3000, 2000), 'wide.jpg');
    assert.ok(out.width <= MAX_EDGE && out.height <= MAX_EDGE);
    // 3:2 in, 3:2 out.
    assert.ok(Math.abs(out.width / out.height - 1.5) < 0.01, 'aspect ratio changed');
  });

  it('does not enlarge a small image', async () => {
    // A logo upscaled to 2000px is a blurry logo, not a better one.
    const out = await processImage(await noisyJpeg(320, 200), 'logo.png');
    assert.equal(out.width, 320);
    assert.equal(out.height, 200);
  });

  it('strips EXIF, including GPS', async () => {
    // Site photographs are taken on phones on customers' estates. Publishing
    // their coordinates would put a housing association's property on a map.
    const withExif = await sharp(await noisyJpeg(800, 600))
      .withMetadata({ exif: { IFD0: { Copyright: 'HCS' }, GPS: { GPSLatitudeRef: 'N' } } })
      .jpeg()
      .toBuffer();
    const out = await processImage(withExif, 'estate.jpg');
    const meta = await sharp(out.bytes).metadata();
    assert.ok(!meta.exif, 'EXIF survived the re-encode');
  });

  it('converts to WebP and normalises the filename', async () => {
    const out = await processImage(await noisyJpeg(600, 400), 'fence complete 5.jpeg');
    assert.equal(out.mime, 'image/webp');
    assert.equal(out.filename, 'fence-complete-5.webp');
  });

  it('hashes the output, so the same source twice is the same image', async () => {
    const src = await noisyJpeg(600, 400);
    const a = await processImage(src, 'a.jpg');
    const b = await processImage(src, 'b.jpg');
    assert.equal(a.hash, b.hash, 'identical bytes produced different hashes');
    assert.match(a.hash, /^[a-f0-9]{64}$/);
  });
});

describe('webMediaService.normaliseFilename', () => {
  it('removes the spaces the live site\'s images are full of', () => {
    assert.equal(normaliseFilename('Living wage LOGO.png'), 'living-wage-logo.webp');
    assert.equal(normaliseFilename('fence almost done 3.jpeg'), 'fence-almost-done-3.webp');
  });

  it('always produces a name', () => {
    assert.equal(normaliseFilename(''), 'image.webp');
    assert.equal(normaliseFilename('***.png'), 'image.webp');
  });
});

describe('webMediaService.fileFilter', () => {
  const call = (originalname, mimetype) => new Promise((resolve) => {
    fileFilter({}, { originalname, mimetype }, (err, ok) => resolve({ err, ok }));
  });

  it('accepts the formats a phone or camera produces', async () => {
    for (const [name, mime] of [['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.png', 'image/png'], ['a.webp', 'image/webp']]) {
      const { err, ok } = await call(name, mime);
      assert.ok(ok && !err, `${name} was rejected`);
    }
  });

  it('rejects SVG', async () => {
    // These bytes are mirrored and served by heroncs.co.uk. An SVG is a
    // script-bearing document, not an image.
    const { err, ok } = await call('logo.svg', 'image/svg+xml');
    assert.ok(err && !ok);
  });

  it('rejects a mismatch between extension and declared type', async () => {
    const { err } = await call('payload.php', 'image/jpeg');
    assert.ok(err, 'a .php with an image mime was accepted');
  });
});
