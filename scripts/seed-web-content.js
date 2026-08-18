#!/usr/bin/env node
/**
 * One-off import of the live website's content into the WEB namespace.
 *
 * The editor at /website is useless on an empty database: nobody writes their
 * first case study by re-typing the one already on the site. This reads the
 * content out of an hcs-web checkout — its services/*Data.js files and its
 * public/images — and creates the matching records.
 *
 *   node scripts/seed-web-content.js --from ~/code/hcs-web [--publish] [--dry-run]
 *
 * Notes on the shape of this:
 *
 * - **It takes a path rather than bundling a fixture.** The seed is 7.3MB of
 *   photographs; copying them into this repo would put them in every image
 *   build for the sake of a script that runs once.
 * - **It is idempotent by slug and by image hash.** Re-running adds nothing and
 *   overwrites nothing, so it is safe to run again after a partial failure.
 * - **Everything lands as a draft unless --publish is passed.** The images are
 *   the exception: an unpublished image referenced by a published page renders
 *   as a hole, and the media library is not itself a public listing.
 * - hcs-web is CommonJS; this is ESM. createRequire is what bridges them.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import mdb from '../mongoose/services/mongooseDatabaseService.js';
import { slugify } from '../services/webContentService.js';
import { processImage } from '../services/webMediaService.js';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const FROM = arg('--from');
const PUBLISH = has('--publish');
const DRY = has('--dry-run');

if (!FROM) {
  console.error('Usage: node scripts/seed-web-content.js --from /path/to/hcs-web [--publish] [--dry-run]');
  process.exit(1);
}

const root = path.resolve(FROM.replace(/^~/, process.env.HOME || '~'));
const require_ = createRequire(import.meta.url);
const load = (file) => require_(path.join(root, 'services', file));

const state = { media: 0, studies: 0, posts: 0, services: 0, accreditations: 0, site: 0, skipped: 0 };
const publishFields = () => (PUBLISH ? { status: 'published', publishedAt: new Date() } : { status: 'draft' });

/**
 * Imports an image referenced by the site as "/images/fence before.jpeg".
 * Returns the media uuid, or '' when the file is missing — which is not an
 * error worth stopping for: the live data files reference a couple of images
 * that were never added.
 */
const mediaByPath = new Map();
async function importImage(webPath, alt = '') {
  if (!webPath) return '';
  if (mediaByPath.has(webPath)) return mediaByPath.get(webPath);

  const file = path.join(root, 'public', webPath.replace(/^\//, '').replace(/\\/g, '/'));
  if (!fs.existsSync(file)) {
    console.warn(`  ! missing image, skipped: ${webPath}`);
    mediaByPath.set(webPath, '');
    return '';
  }

  const processed = await processImage(fs.readFileSync(file), path.basename(file));
  const existing = await mdb.WEB.webMedia.findOne({ hash: processed.hash }).select('uuid').lean();
  if (existing) {
    mediaByPath.set(webPath, existing.uuid);
    return existing.uuid;
  }
  if (DRY) {
    mediaByPath.set(webPath, 'dry-run');
    console.log(`  + image ${processed.filename} (${Math.round(processed.size / 1024)}KB)`);
    return 'dry-run';
  }

  const doc = await mdb.WEB.webMedia.create({
    filename: processed.filename,
    originalName: path.basename(file),
    mime: processed.mime,
    bytes: processed.bytes,
    size: processed.size,
    width: processed.width,
    height: processed.height,
    hash: processed.hash,
    alt,
    status: 'published',
    publishedAt: new Date(),
  });
  state.media += 1;
  mediaByPath.set(webPath, doc.uuid);
  console.log(`  + image ${processed.filename} (${Math.round(processed.size / 1024)}KB)`);
  return doc.uuid;
}

const SINGULAR = {
  studies: 'case study', posts: 'post', services: 'service', accreditations: 'accreditation',
};

async function createIfNew(Model, slug, doc, counter) {
  const existing = await Model.findOne({ slug }).select('uuid').lean();
  if (existing) {
    state.skipped += 1;
    return false;
  }
  if (!DRY) await Model.create({ ...doc, slug });
  state[counter] += 1;
  console.log(`  + ${SINGULAR[counter] || counter}: ${slug}`);
  return true;
}

async function main() {
  console.log(`Seeding the WEB namespace from ${root}${DRY ? ' (dry run)' : ''}`);
  await mdb.connect();

  // ── Case studies ──────────────────────────────────────────────────────────
  const { getPosts } = load('blogData.js');
  const { getServices } = load('servicesData.js');
  const { getAccreditations } = load('accreditationsData.js');
  const { getSite, getOffices } = load('siteData.js');
  const { getStudies } = load('caseStudyData.js');
  const studies = getStudies();

  for (const s of studies) {
    const panel = async (p) => (p ? { media: await importImage(p.image, p.alt), alt: p.alt || '', caption: p.caption || '' } : { media: '', alt: '', caption: '' });
    await createIfNew(mdb.WEB.webCaseStudy, s.slug || slugify(s.title), {
      title: s.title,
      client: s.client || '',
      location: s.location || '',
      scope: s.scope || '',
      excerpt: s.excerpt || '',
      card: { media: await importImage(s.cardImage, s.cardImageAlt), alt: s.cardImageAlt || '' },
      before: await panel(s.before),
      after: await panel(s.after),
      gallery: await Promise.all((s.gallery || []).map(async (g) => ({
        media: await importImage(g.image, g.alt), alt: g.alt || '', caption: g.caption || '',
      }))),
      contentHtml: s.content || '',
      socialValue: s.socialValue || '',
      ...publishFields(),
    }, 'studies');
  }

  // ── Blog posts ────────────────────────────────────────────────────────────
  for (const p of getPosts()) {
    await createIfNew(mdb.WEB.webPost, p.slug || slugify(p.title), {
      title: p.title,
      excerpt: p.excerpt || '',
      contentHtml: p.content || '',
      author: p.author || 'HCS Team',
      tags: p.tags || [],
      ...publishFields(),
      publishedAt: PUBLISH && p.publishedAt ? new Date(p.publishedAt) : publishFields().publishedAt || null,
    }, 'posts');
  }

  // ── Services ──────────────────────────────────────────────────────────────
  let order = 0;
  for (const s of getServices()) {
    order += 10;
    await createIfNew(mdb.WEB.webService, s.slug || slugify(s.title), {
      title: s.title,
      description: s.description || '',
      image: { media: await importImage(s.image, s.imageAlt), alt: s.imageAlt || '' },
      href: s.href || '/contact',
      cta: s.cta || 'Enquire',
      pageTitle: s.pageTitle || '',
      metaDescription: s.metaDescription || '',
      sortOrder: order,
      ...publishFields(),
    }, 'services');
  }

  // ── Accreditations ────────────────────────────────────────────────────────
  order = 0;
  for (const a of getAccreditations()) {
    order += 10;
    await createIfNew(mdb.WEB.webAccreditation, slugify(a.name), {
      name: a.name,
      logo: { media: await importImage(a.logo, a.alt), alt: a.alt || a.name },
      description: a.description || '',
      membershipNumber: a.membershipNumber || '',
      sortOrder: order,
      ...publishFields(),
    }, 'accreditations');
  }

  // ── Site settings ─────────────────────────────────────────────────────────
  const existingSite = await mdb.WEB.webSiteSettings.findOne({ key: 'site' }).select('uuid').lean();
  if (existingSite) {
    state.skipped += 1;
  } else {
    const site = getSite();
    const doc = {
      key: 'site',
      name: site.name || '',
      email: site.email || '',
      tagline: site.tagline || '',
      companyNumber: site.companyNumber || '',
      registrationCountry: site.registrationCountry || '',
      companyType: site.companyType || '',
      vatNumber: site.vatNumber || '',
      robots: site.robots || 'index, follow',
      ogType: site.ogType || 'website',
      twitterCard: site.twitterCard || 'summary_large_image',
      themeColor: site.themeColor || '#ffffff',
      locale: site.locale || 'en_GB',
      twitterHandle: site.twitterHandle || '',
      instagramHandle: site.instagramHandle || '',
      facebookHandle: site.facebookHandle || '',
      linkedinHandle: site.linkedinHandle || '',
      inboxMonitored: site.inbox?.monitored || '',
      inboxResponse: site.inbox?.response || '',
      hours: site.hours || [],
      offices: (getOffices ? getOffices(site) : []).map((o) => ({
        label: o.label, phone: o.phone, address: o.address,
      })),
      ...publishFields(),
    };
    if (!DRY) await mdb.WEB.webSiteSettings.create(doc);
    state.site = 1;
    console.log('  + site settings');
  }

  console.log('\nDone.', JSON.stringify(state));
  if (!PUBLISH) {
    console.log('Everything imported as a draft. Review it at /website, then publish.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
