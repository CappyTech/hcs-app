/**
 * brandService — the app's icon, colour, web manifest and offline page, read
 * from configuration instead of files shipped in the image.
 *
 * hcs-app is deployed once per company, so the image must not carry one
 * company's logo or colours. Everything here has a neutral default that a
 * fresh install renders straight away:
 *
 *   - **Icon.** An admin uploads one square image on Admin → Branding. It is
 *     normalised once to a 512×512 PNG (re-encoding also drops anything that
 *     is not pixels) and kept in INTERNAL.appIcon, so it survives a redeploy.
 *     Every size the browser asks for is resized from that and cached in
 *     memory. With no upload, a plain generated mark in the brand colour is
 *     used. It is drawn from shapes only: the Alpine image has no fonts, so
 *     initials would rasterise to nothing.
 *   - **Colour.** BRAND_COLOUR (Admin → Configuration → Appearance) picks one
 *     of a few Tailwind palettes. The CSS build maps Tailwind's `green-*`
 *     classes to `--brand-*` variables, and /brand/palette.css sets them. Only
 *     calm palettes are offered: green is also the app's "approved/success"
 *     colour, so a red or amber brand would make every success look like an
 *     error.
 *   - **Manifest and offline page.** Rendered per request from the company
 *     name, colour and icon.
 *
 * Every route that serves these is public and mounted before the database
 * connects (the manifest and icons are fetched while signed out), so nothing
 * here may throw when the database is not there yet: it falls back to the
 * generated icon.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

import configService from './configService.js';
import organisation from './organisationService.js';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import logger from './loggerService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Tailwind v3 palettes, shades 50–950. Green is the default and matches the built CSS. */
export const PALETTES = {
  green:   ['#f0fdf4', '#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534', '#14532d', '#052e16'],
  emerald: ['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22'],
  teal:    ['#f0fdfa', '#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59', '#134e4a', '#042f2e'],
  cyan:    ['#ecfeff', '#cffafe', '#a5f3fc', '#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490', '#155e75', '#164e63', '#083344'],
  sky:     ['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e', '#082f49'],
  blue:    ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554'],
  indigo:  ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b'],
  violet:  ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'],
};

export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** Sizes the icon route serves. Anything else is a 404, so the cache cannot be grown without bound. */
export const ICON_SIZES = [32, 64, 180, 192, 256, 512];

const DEFAULT_COLOUR = 'green';

/** The configured palette name, or green when unset or not one we offer. */
export function brandColour() {
  const raw = String(configService.get('BRAND_COLOUR', '') ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PALETTES, raw) ? raw : DEFAULT_COLOUR;
}

/** Hex of one shade of the configured palette. */
export function shade(n, colour = brandColour()) {
  const i = SHADES.indexOf(n);
  return PALETTES[colour][i < 0 ? 6 : i];
}

/** The colour browsers paint the title bar with: the shade the nav uses. */
export function themeColour() {
  return shade(700);
}

const hexToTriplet = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** CSS custom properties for the configured palette, as the built CSS expects them. */
export function paletteCss(colour = brandColour()) {
  const vars = SHADES.map((s, i) => `--brand-${s}: ${hexToTriplet(PALETTES[colour][i])};`).join(' ');
  return `:root { ${vars} }\n`;
}

// ── Icon ────────────────────────────────────────────────────────────────────

const state = {
  /** 512×512 PNG an admin uploaded, or null for the generated mark. */
  upload: null,
  /** Changes when the upload changes; part of every icon URL so browsers refetch. */
  uploadVersion: '0',
};
const rendered = new Map();

function model() {
  return mdb.INTERNAL && mdb.INTERNAL.appIcon;
}

/**
 * Read the uploaded icon from the database into memory. Called once the
 * database is connected and again after every change. Never throws: a failure
 * leaves the generated mark in place.
 */
export async function load() {
  const AppIcon = model();
  if (!AppIcon) return;
  try {
    const doc = await AppIcon.findOne({ singleton: 'global' }).lean();
    const data = doc?.data ? Buffer.from(doc.data.buffer ?? doc.data) : null;
    state.upload = data && data.length ? data : null;
    state.uploadVersion = state.upload ? String(new Date(doc.updatedAt || Date.now()).getTime()) : '0';
    rendered.clear();
  } catch (err) {
    logger.warn(`[brandService] Could not load the app icon: ${err.message}`);
  }
}

/** True when an admin has uploaded an icon. */
export function hasUploadedIcon() {
  return !!state.upload;
}

/**
 * Cache-busting token for icon URLs. The generated mark depends on the colour,
 * so the colour is part of it.
 */
export function assetVersion() {
  return `${state.uploadVersion}-${brandColour()}`;
}

/**
 * The generated mark: a rounded square in the brand colour holding three
 * white blocks of rising height. No text, so it renders without fonts.
 */
export function generatedIconSvg(colour = brandColour(), { maskable = false } = {}) {
  const bg = shade(700, colour);
  // A maskable icon is cropped to a circle of 80% of its width, so the
  // background runs to the edges and the blocks stay inside the middle.
  const radius = maskable ? 0 : 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${radius}" fill="${bg}"/>
  <g fill="#ffffff">
    <rect x="156" y="276" width="56" height="100" rx="10"/>
    <rect x="228" y="216" width="56" height="160" rx="10"/>
    <rect x="300" y="146" width="56" height="230" rx="10"/>
  </g>
</svg>`;
}

/**
 * A PNG of the icon at one of ICON_SIZES. `maskable` gives the 512 variant
 * with a safe zone, for Android's adaptive icons.
 */
export async function iconPng(size, { maskable = false } = {}) {
  if (!ICON_SIZES.includes(size)) throw new RangeError(`Unsupported icon size ${size}`);
  const key = `${assetVersion()}:${size}:${maskable ? 'm' : 'a'}`;
  if (rendered.has(key)) return rendered.get(key);

  let png;
  if (state.upload) {
    if (maskable) {
      // Shrink the upload into the safe zone on a white square.
      const inner = Math.round(size * 0.72);
      const logo = await sharp(state.upload).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      png = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
        .composite([{ input: logo, gravity: 'centre' }]).png().toBuffer();
    } else {
      png = await sharp(state.upload).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    }
  } else {
    png = await sharp(Buffer.from(generatedIconSvg(brandColour(), { maskable }))).resize(size, size).png().toBuffer();
  }
  rendered.set(key, png);
  return png;
}

/**
 * Turn an uploaded image into the stored 512×512 PNG. Rejects anything sharp
 * cannot read as a raster image. SVG is refused: it is a script-bearing
 * document, and these icons are served to signed-out visitors.
 */
export async function normaliseUpload(buffer) {
  if (!buffer || !buffer.length) throw new Error('No image was uploaded.');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new Error('That file is not an image this app can read. Use a PNG, JPEG or WebP.');
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) {
    throw new Error('Use a PNG, JPEG or WebP image.');
  }
  if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64) {
    throw new Error('The image is too small. Use one at least 192 pixels square, ideally 512.');
  }
  return sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** Store a new icon (already normalised) and refresh the in-memory copy. */
export async function saveIcon(png, username = null) {
  const AppIcon = model();
  if (!AppIcon) throw new Error('The database is not connected.');
  await AppIcon.findOneAndUpdate(
    { singleton: 'global' },
    { $set: { data: png, mime: 'image/png', updatedBy: username } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await load();
}

/** Remove the uploaded icon, going back to the generated mark. */
export async function removeIcon() {
  const AppIcon = model();
  if (!AppIcon) throw new Error('The database is not connected.');
  await AppIcon.deleteOne({ singleton: 'global' });
  await load();
}

/** URL of one icon size, with the cache-busting token. */
export function iconUrl(size) {
  return `/brand/icon-${size}.png?v=${encodeURIComponent(assetVersion())}`;
}

// ── Manifest and offline page ───────────────────────────────────────────────

/** The web app manifest for this company. */
export function manifest() {
  const name = organisation.companyName();
  const shortName = organisation.companyShortName();
  const icon192 = iconUrl(192);
  const shortcut = (label, description, url) => ({
    name: label,
    short_name: label,
    description,
    url,
    icons: [{ src: icon192, sizes: '192x192', type: 'image/png' }],
  });
  return {
    id: '/',
    name,
    short_name: shortName.length > 12 ? shortName.slice(0, 12).trim() : shortName,
    description: `${name} management system: people, attendance, documents and finance.`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f9fafb',
    theme_color: themeColour(),
    icons: [
      { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconUrl(256), sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: iconUrl(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/brand/maskable-512.png?v=${encodeURIComponent(assetVersion())}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      shortcut('Attendance', 'Record and review attendance', '/attendance'),
      shortcut('Create', 'Create a new record', '/create'),
      shortcut('Documents', 'Company documents', '/documents'),
    ],
  };
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let offlineTemplate = null;
function readOfflineTemplate() {
  if (offlineTemplate === null) {
    offlineTemplate = fs.readFileSync(path.join(__dirname, '..', 'public', 'offline.html'), 'utf8');
  }
  return offlineTemplate;
}

/**
 * The page the service worker shows when the network is down. The template in
 * public/offline.html carries {{COMPANY_NAME}} and {{THEME_COLOUR}}
 * placeholders. Its logo is /brand/icon-192.png with no version, because the
 * service worker precaches it under that exact URL.
 */
export function offlineHtml() {
  return readOfflineTemplate()
    .replace(/\{\{COMPANY_NAME\}\}/g, escapeHtml(organisation.companyName()))
    .replace(/\{\{THEME_COLOUR\}\}/g, themeColour());
}

/** Test hook: forget the cached template and icon. */
export function _resetForTests() {
  offlineTemplate = null;
  state.upload = null;
  state.uploadVersion = '0';
  rendered.clear();
}

export default {
  PALETTES, SHADES, ICON_SIZES,
  brandColour, shade, themeColour, paletteCss,
  load, hasUploadedIcon, assetVersion, generatedIconSvg, iconPng,
  normaliseUpload, saveIcon, removeIcon, iconUrl,
  manifest, offlineHtml, _resetForTests,
};
