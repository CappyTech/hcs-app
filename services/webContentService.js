/**
 * Builds the content payload that hcs-web pulls and mirrors.
 *
 * hcs-web is a *cache* of this data, not a client of it: it writes whatever
 * this returns to disk and serves the public site from that copy, so
 * heroncs.co.uk keeps working with hcs-app switched off entirely. Two
 * consequences shape everything here.
 *
 * 1. **The payload is self-contained.** No pagination, no follow-up lookups for
 *    anything the page needs to render. The one exception is image bytes, which
 *    are fetched per-uuid and mirrored separately — see media[] below.
 *
 * 2. **Only `status: 'published'` is ever included.** That filter lives here,
 *    once, rather than in each route: a record being visible on the public
 *    internet is a property of the record, never of the caller that read it.
 *    tests/webContentService.test.js pins it.
 *
 * Field names deliberately match hcs-web's services/*Data.js objects, so its
 * getters can return these straight through without a translation layer.
 */
import crypto from 'crypto';
import mdb from '../mongoose/services/mongooseDatabaseService.js';

/** Records a consumer may render. Everything else is invisible to the API. */
const PUBLISHED = { status: 'published' };

/** URL-safe slug. Mirrors the slugs already in hcs-web's data files. */
export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * An image reference as the consumer sees it: the media uuid plus the alt text
 * for *this* usage.
 *
 * The uuid rather than a URL is deliberate — hcs-web mirrors the bytes locally
 * and serves them from its own path, so a URL minted here would either be wrong
 * or would tie the public site's page loads to this host being reachable, which
 * is the whole thing this design avoids.
 */
function imageOut(ref, fallbackAlt = '') {
  if (!ref || !ref.media) return null;
  return { media: ref.media, alt: ref.alt || fallbackAlt };
}

function studyOut(d) {
  return {
    slug: d.slug,
    title: d.title,
    client: d.client || '',
    location: d.location || '',
    scope: d.scope || '',
    excerpt: d.excerpt || '',
    card: imageOut(d.card),
    before: d.before && d.before.media
      ? { ...imageOut(d.before), caption: d.before.caption || '' }
      : null,
    after: d.after && d.after.media
      ? { ...imageOut(d.after), caption: d.after.caption || '' }
      : null,
    gallery: (d.gallery || [])
      .filter((g) => g && g.media)
      .map((g) => ({ ...imageOut(g), caption: g.caption || '' })),
    content: d.contentHtml || '',
    socialValue: d.socialValue || null,
    publishedAt: d.publishedAt || null,
  };
}

function postOut(d) {
  return {
    slug: d.slug,
    title: d.title,
    excerpt: d.excerpt || '',
    content: d.contentHtml || '',
    author: d.author || '',
    // hcs-web renders this as a plain date string; ISO keeps it sortable and
    // unambiguous, and the consumer formats it.
    publishedAt: d.publishedAt ? new Date(d.publishedAt).toISOString() : null,
    tags: d.tags || [],
  };
}

function serviceOut(d) {
  return {
    slug: d.slug,
    title: d.title,
    description: d.description || '',
    image: imageOut(d.image),
    // hcs-web's own convention: anything other than /contact means the service
    // has a dedicated page, which is also what promotes it in the footer.
    href: d.href || '/contact',
    cta: d.cta || 'Enquire',
    pageTitle: d.pageTitle || '',
    metaDescription: d.metaDescription || '',
    content: d.contentHtml || '',
  };
}

function accreditationOut(d) {
  return {
    slug: d.slug,
    name: d.name,
    logo: imageOut(d.logo, d.name),
    description: d.description || '',
    membershipNumber: d.membershipNumber || '',
    validFrom: d.validFrom ? new Date(d.validFrom).toISOString() : null,
    validTo: d.validTo ? new Date(d.validTo).toISOString() : null,
    certificateUrl: d.certificateUrl || '',
  };
}

function siteOut(d) {
  if (!d) return null;
  return {
    name: d.name || '',
    email: d.email || '',
    tagline: d.tagline || '',
    companyNumber: d.companyNumber || '',
    registrationCountry: d.registrationCountry || '',
    companyType: d.companyType || '',
    vatNumber: d.vatNumber || '',
    robots: d.robots || 'index, follow',
    ogType: d.ogType || 'website',
    ogImage: d.ogImage || '',
    twitterCard: d.twitterCard || 'summary_large_image',
    themeColor: d.themeColor || '#ffffff',
    locale: d.locale || 'en_GB',
    twitterHandle: d.twitterHandle || '',
    instagramHandle: d.instagramHandle || '',
    facebookHandle: d.facebookHandle || '',
    linkedinHandle: d.linkedinHandle || '',
    inbox: { monitored: d.inboxMonitored || '', response: d.inboxResponse || '' },
    hours: (d.hours || []).map((h) => ({ days: h.days || '', time: h.time || '' })),
    offices: (d.offices || []).map((o) => ({
      label: o.label || '',
      phone: o.phone || '',
      address: {
        line1: o.address?.line1 || '',
        line2: o.address?.line2 || '',
        line3: o.address?.line3 || '',
        line4: o.address?.line4 || '',
        postcode: o.address?.postcode || '',
      },
    })),
  };
}

/**
 * Image *metadata* only — never the bytes.
 *
 * The manifest is what lets hcs-web mirror incrementally: it compares each
 * hash against what it already holds and fetches only the changed ones from
 * /api/web/media/:uuid. Inlining the bytes here would put every photo on the
 * wire on every poll, several megabytes at a time, to answer a question that is
 * almost always "nothing changed".
 */
function mediaOut(d) {
  return {
    uuid: d.uuid,
    filename: d.filename,
    mime: d.mime,
    size: d.size || 0,
    width: d.width || 0,
    height: d.height || 0,
    hash: d.hash || '',
    alt: d.alt || '',
  };
}

/** Everything published, in one document. */
export async function buildPayload() {
  const W = mdb.WEB;
  const [site, services, accreditations, posts, studies, media] = await Promise.all([
    W.webSiteSettings.findOne(PUBLISHED).lean(),
    W.webService.find(PUBLISHED).sort({ sortOrder: 1, title: 1 }).lean(),
    W.webAccreditation.find(PUBLISHED).sort({ sortOrder: 1, name: 1 }).lean(),
    W.webPost.find(PUBLISHED).sort({ publishedAt: -1, createdAt: -1 }).lean(),
    W.webCaseStudy.find(PUBLISHED).sort({ sortOrder: 1, title: 1 }).lean(),
    W.webMedia.find(PUBLISHED).select('-bytes').sort({ createdAt: 1 }).lean(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    site: siteOut(site),
    services: services.map(serviceOut),
    accreditations: accreditations.map(accreditationOut),
    posts: posts.map(postOut),
    studies: studies.map(studyOut),
    media: media.map(mediaOut),
  };
}

/**
 * Content hash of a payload, used as its ETag.
 *
 * generatedAt is excluded, which is the point: it changes on every call, so
 * hashing it would make every poll a 200 with a full body and the 304 path
 * would never fire.
 */
export function payloadEtag(payload) {
  const { generatedAt, ...stable } = payload;
  return `"${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32)}"`;
}

export default { slugify, buildPayload, payloadEtag };
