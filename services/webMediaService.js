/**
 * Prepares an uploaded photograph for the public website.
 *
 * The Website Design Brief sets a 300KB ceiling per image and forbids stock
 * photography; the live site currently carries 15 files over that limit, two of
 * them ~1MB. Rather than trusting whoever uploads to have exported correctly,
 * every image is re-encoded here.
 *
 * Three things this does that are easy to leave out and expensive to add later:
 *
 * - **Strips metadata.** sharp drops EXIF unless asked to keep it, which is the
 *   behaviour we want: site photographs are taken on phones on customers'
 *   estates, and EXIF carries GPS coordinates. Publishing those would put the
 *   location of a housing association's property on the internet.
 * - **Normalises the filename.** The existing images are named "fence complete
 *   5.jpeg" — spaces and all — which is why referencing them is awkward.
 * - **Rejects SVG.** These bytes are mirrored and served by heroncs.co.uk, and
 *   an SVG is a script-bearing document, not an image.
 */
import crypto from 'crypto';
import path from 'path';
import sharp from 'sharp';

/** Longest edge, in pixels. Comfortably covers a full-width hero on 2x. */
export const MAX_EDGE = 2000;

/** The brief's ceiling. */
export const MAX_BYTES = 300 * 1024;

/**
 * The ladder tried in order until the output fits MAX_BYTES.
 *
 * It steps down *quality first, then dimensions*, because dropping resolution
 * is the more visible loss and should be the later resort. The last entry is
 * accepted whatever it weighs: a slightly oversized image is a better outcome
 * than an upload that fails with nothing the person can act on.
 *
 * Dimensions matter as well as quality because quality alone does not converge
 * on a detailed photograph — foliage, gravel and brickwork, which is most of
 * what this company photographs, compress badly at any quality.
 */
const LADDER = [
  { edge: MAX_EDGE, quality: 82 },
  { edge: MAX_EDGE, quality: 72 },
  { edge: MAX_EDGE, quality: 62 },
  { edge: 1600, quality: 62 },
  { edge: 1280, quality: 60 },
  { edge: 1024, quality: 58 },
  { edge: 800, quality: 55 },
];

/** Uploads we accept. Deliberately no image/svg+xml — see the header. */
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/** multer fileFilter: checks the declared mime AND the extension. */
export function fileFilter(req, file, cb) {
  const extOk = /\.(jpe?g|png|webp|avif)$/i.test(file.originalname || '');
  const mimeOk = ALLOWED_MIME.has(String(file.mimetype || '').toLowerCase());
  if (extOk && mimeOk) return cb(null, true);
  return cb(new Error('Only JPEG, PNG, WebP or AVIF images are accepted.'));
}

/** "fence complete 5.jpeg" → "fence-complete-5.webp" */
export function normaliseFilename(originalName, ext = 'webp') {
  const base = path.basename(String(originalName || 'image'), path.extname(String(originalName || '')));
  const clean = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'image';
  return `${clean}.${ext}`;
}

/**
 * Re-encode to WebP within the size and dimension limits.
 *
 * Returns { bytes, mime, size, width, height, filename, hash }. The hash is of
 * the *output*, so re-uploading the same source file twice produces the same
 * hash and hcs-web's mirror skips the re-fetch.
 */
export async function processImage(buffer, originalName) {
  const meta = await sharp(buffer).metadata();

  let out = null;
  for (const step of LADDER) {
    // withoutEnlargement: a small logo stays its own size rather than being
    // upscaled into a blurry 2000px version of itself.
    out = await sharp(buffer, { failOn: 'error' })
      .rotate()  // apply EXIF orientation before it is discarded
      .resize({ width: step.edge, height: step.edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: step.quality })
      .toBuffer({ resolveWithObject: true });
    if (out.data.length <= MAX_BYTES) break;
  }

  return {
    bytes: out.data,
    mime: 'image/webp',
    size: out.data.length,
    width: out.info.width,
    height: out.info.height,
    // Source dimensions are not kept: the stored image is the only one served,
    // so its own dimensions are the ones a consumer needs.
    filename: normaliseFilename(originalName),
    hash: crypto.createHash('sha256').update(out.data).digest('hex'),
    sourceFormat: meta.format || '',
  };
}

export default { processImage, fileFilter, normaliseFilename, MAX_EDGE, MAX_BYTES, ALLOWED_MIME };
