/**
 * The website content editor at /website.
 *
 * Generic over webContentConfig.js: every collection type shares one list view
 * and one form view, and the config is the write whitelist — a body field that
 * is not declared there is not written. That is what keeps `status` out of
 * reach of a hand-rolled POST: publishing is its own route, so a record cannot
 * be pushed onto the public internet by adding a hidden input to a form.
 *
 * contentHtml is pre-sanitised by the global xssSanitize middleware
 * (securityService.js RICH_TEXT_FIELDS), exactly as company-docs relies on.
 * No second filterXSS call here.
 */
import multer from 'multer';
import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';
import csrfService from '../../services/csrfService.js';
import webContentConfig from '../config/webContentConfig.js';
import { slugify } from '../../services/webContentService.js';
import webMediaService from '../../services/webMediaService.js';
import { notifyWebRevalidate } from '../../services/webRevalidateService.js';
import { buildUsageMap, usageFor, repointReferences } from '../../services/webMediaUsageService.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function typeOr404(type) {
  const cfg = webContentConfig[type];
  if (!cfg) {
    throw Object.assign(new Error('Unknown content type'), { statusCode: 404 });
  }
  return cfg;
}

function modelFor(cfg) {
  return mdb.WEB[cfg.model];
}

/** The field that names a record: most types use `title`, accreditations `name`. */
function titleField(cfg) {
  return cfg.fields.some((f) => f.name === 'title') ? 'title' : 'name';
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Form arrays arrive as { '0': {...}, '1': {...} } or a real array. Normalise. */
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

function imageFrom(v) {
  return { media: str(v?.media), alt: str(v?.alt) };
}

function panelFrom(v) {
  return { ...imageFrom(v), caption: str(v?.caption) };
}

/**
 * Build a mongo update from the body, driven entirely by the config.
 *
 * Anything not declared in cfg.fields is ignored — including `status`,
 * `publishedAt`, `uuid` and the audit stamps, none of which a form may set.
 */
function updateFromBody(cfg, body) {
  const update = {};
  for (const field of cfg.fields) {
    const raw = body[field.name];
    if (raw === undefined) continue;
    switch (field.type) {
      case 'number':
        update[field.name] = Number.isFinite(Number(raw)) ? Number(raw) : 0;
        break;
      case 'date':
        update[field.name] = str(raw) ? new Date(str(raw)) : null;
        break;
      case 'tags':
        update[field.name] = str(raw).split(',').map((t) => t.trim()).filter(Boolean);
        break;
      case 'image':
        update[field.name] = imageFrom(raw);
        break;
      case 'panel':
        update[field.name] = panelFrom(raw);
        break;
      case 'gallery':
        update[field.name] = toArray(raw).map(panelFrom).filter((g) => g.media);
        break;
      case 'hours':
        update[field.name] = toArray(raw)
          .map((h) => ({ days: str(h?.days), time: str(h?.time) }))
          .filter((h) => h.days || h.time);
        break;
      case 'offices':
        update[field.name] = toArray(raw)
          .map((o) => ({
            label: str(o?.label),
            phone: str(o?.phone),
            address: {
              line1: str(o?.address?.line1),
              line2: str(o?.address?.line2),
              line3: str(o?.address?.line3),
              line4: str(o?.address?.line4),
              postcode: str(o?.address?.postcode),
            },
          }))
          .filter((o) => o.label || o.phone || o.address.line1);
        break;
      case 'richtext':
        // Already sanitised globally; stored as-is.
        update[field.name] = typeof raw === 'string' ? raw : '';
        break;
      default:
        update[field.name] = str(raw);
    }
  }
  return update;
}

/**
 * A slug that is unique within the collection.
 *
 * Generated from the title when the field is left blank, which is the normal
 * case — the slug is the public URL, and asking someone writing a case study to
 * invent one is how you end up with "case-study-final-2".
 */
async function uniqueSlug(cfg, Model, desired, fallbackFrom, excludeUuid) {
  const base = slugify(desired || fallbackFrom) || 'untitled';
  let candidate = base;
  for (let n = 2; n < 100; n += 1) {
    const clash = await Model.findOne({ slug: candidate, ...(excludeUuid ? { uuid: { $ne: excludeUuid } } : {}) })
      .select('uuid').lean();
    if (!clash) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/** Media the pickers offer. Metadata only — never the bytes. */
async function mediaChoices() {
  return mdb.WEB.webMedia.find({}).select('-bytes').sort({ createdAt: -1 }).lean();
}

// ── Collection types ─────────────────────────────────────────────────────────

export const getList = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    if (cfg.singleton) return res.redirect('/website/settings');
    const records = await modelFor(cfg).find({}).select('-bytes').sort(cfg.defaultSort || { createdAt: -1 }).lean();
    res.render('tailwindcss/website/list', {
      title: cfg.plural,
      type: req.params.type,
      cfg,
      records,
      titleField: titleField(cfg),
    });
  } catch (err) {
    next(err);
  }
};

export const getCreate = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    res.render('tailwindcss/website/form', {
      title: `New ${cfg.label}`,
      type: req.params.type,
      cfg,
      record: null,
      media: await mediaChoices(),
      // Loads Quill in layout.ejs. See webContentConfig's header for why there
      // is never more than one richtext field on a page.
      quillEditor: cfg.fields.some((f) => f.type === 'richtext'),
    });
  } catch (err) {
    next(err);
  }
};

// A create that fails validation goes back to the form with each problem under
// its field (WCAG 3.3.1 / 3.3.3), keyed by the input id `f-<name>` in _field.ejs.
function webFieldErrors(cfg, err) {
  const entries = err?.name === 'CastError' && err.path ? [[err.path, err]] : Object.entries(err?.errors || {});
  const fieldErrors = {};
  for (const [p, e] of entries) {
    const name = String(p).split('.')[0];
    const field = cfg.fields.find((f) => f.name === name);
    if (!field) continue;
    let msg;
    if (e?.kind === 'required') msg = `${field.label} is required.`;
    else if (field.type === 'date') msg = `${field.label} is not a real date. Pick one from the calendar, or leave it blank.`;
    else if (field.type === 'number') msg = `${field.label} must be a number.`;
    else if (e?.kind === 'enum') msg = `${field.label} must be one of the listed options.`;
    else msg = `${field.label}: ${String(e?.message || 'this value is not valid.').replace(/^Path `[^`]+` /, '')}`;
    fieldErrors[`f-${name}`] = msg;
  }
  return fieldErrors;
}

export const postCreate = async (req, res, next) => {
  let cfg = null;
  let update = null;
  try {
    cfg = typeOr404(req.params.type);
    const Model = modelFor(cfg);
    update = updateFromBody(cfg, req.body);
    update.slug = await uniqueSlug(cfg, Model, update.slug, update[titleField(cfg)]);
    update.createdBy = req.user?._id;
    update.updatedBy = req.user?._id;
    const created = await Model.create(update);
    req.flash('success', `${cfg.label} created as a draft. Publish it when it is ready.`);
    res.redirect(`/website/${req.params.type}/${created.uuid}/edit`);
  } catch (err) {
    if (cfg && update && (err?.name === 'ValidationError' || err?.name === 'CastError')) {
      const fieldErrors = webFieldErrors(cfg, err);
      if (Object.keys(fieldErrors).length) {
        try {
          return res.status(400).render('tailwindcss/website/form', {
            title: `New ${cfg.label}`,
            type: req.params.type,
            cfg,
            record: null,
            formValues: update,
            fieldErrors,
            media: await mediaChoices(),
            quillEditor: cfg.fields.some((f) => f.type === 'richtext'),
          });
        } catch (e) {
          return next(e);
        }
      }
    }
    next(err);
  }
};

export const getEdit = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    const record = await modelFor(cfg).findOne({ uuid: req.params.uuid }).lean();
    if (!record) {
      return next(Object.assign(new Error(`${cfg.label} not found`), { statusCode: 404 }));
    }
    res.render('tailwindcss/website/form', {
      title: record[titleField(cfg)] || cfg.label,
      type: req.params.type,
      cfg,
      record,
      media: await mediaChoices(),
      quillEditor: cfg.fields.some((f) => f.type === 'richtext'),
    });
  } catch (err) {
    next(err);
  }
};

export const postEdit = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    const Model = modelFor(cfg);
    const existing = await Model.findOne({ uuid: req.params.uuid }).select('uuid slug status').lean();
    if (!existing) {
      return next(Object.assign(new Error(`${cfg.label} not found`), { statusCode: 404 }));
    }
    const update = updateFromBody(cfg, req.body);
    update.slug = await uniqueSlug(cfg, Model, update.slug, update[titleField(cfg)], existing.uuid);
    update.updatedBy = req.user?._id;
    await Model.updateOne({ uuid: existing.uuid }, { $set: update });

    // A published record has just changed what the public site shows.
    if (existing.status === 'published') notifyWebRevalidate('content updated');

    req.flash('success', `${cfg.label} saved.`);
    res.redirect(`/website/${req.params.type}/${existing.uuid}/edit`);
  } catch (err) {
    next(err);
  }
};

/**
 * Publish / unpublish.
 *
 * Its own route rather than a field on the form, so that putting something in
 * front of the public needs a deliberate act. publishedAt is stamped once, on
 * the first publication: it is the date the site displays, not a "last touched"
 * timestamp, and re-publishing after a typo fix should not move an article back
 * to the top of the blog.
 */
export const postPublish = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    const Model = modelFor(cfg);
    const record = await Model.findOne({ uuid: req.params.uuid }).select('uuid publishedAt').lean();
    if (!record) {
      return next(Object.assign(new Error(`${cfg.label} not found`), { statusCode: 404 }));
    }
    await Model.updateOne({ uuid: record.uuid }, {
      $set: {
        status: 'published',
        publishedAt: record.publishedAt || new Date(),
        updatedBy: req.user?._id,
      },
    });
    notifyWebRevalidate(`${cfg.label} published`);
    req.flash('success', `${cfg.label} published. The website updates within a minute.`);
    res.redirect(`/website/${req.params.type}/${record.uuid}/edit`);
  } catch (err) {
    next(err);
  }
};

export const postUnpublish = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    await modelFor(cfg).updateOne(
      { uuid: req.params.uuid },
      { $set: { status: 'draft', updatedBy: req.user?._id } },
    );
    notifyWebRevalidate(`${cfg.label} unpublished`);
    req.flash('success', `${cfg.label} unpublished and back to draft.`);
    res.redirect(`/website/${req.params.type}/${req.params.uuid}/edit`);
  } catch (err) {
    next(err);
  }
};

export const postDelete = async (req, res, next) => {
  try {
    const cfg = typeOr404(req.params.type);
    if (cfg.singleton) {
      return next(Object.assign(new Error('Site settings cannot be deleted'), { statusCode: 400 }));
    }
    const record = await modelFor(cfg).findOne({ uuid: req.params.uuid }).select('uuid status').lean();
    if (record) {
      await modelFor(cfg).deleteOne({ uuid: record.uuid });
      if (record.status === 'published') notifyWebRevalidate(`${cfg.label} deleted`);
    }
    req.flash('success', `${cfg.label} deleted.`);
    res.redirect(`/website/${req.params.type}`);
  } catch (err) {
    next(err);
  }
};

// ── Site settings (singleton) ────────────────────────────────────────────────

export const getSettings = async (req, res, next) => {
  try {
    const cfg = webContentConfig.settings;
    const record = await mdb.WEB.webSiteSettings.findOne({ key: 'site' }).lean();
    res.render('tailwindcss/website/form', {
      title: 'Site Settings',
      type: 'settings',
      cfg,
      record,
      media: await mediaChoices(),
      quillEditor: false,
    });
  } catch (err) {
    next(err);
  }
};

export const postSettings = async (req, res, next) => {
  try {
    const cfg = webContentConfig.settings;
    const update = updateFromBody(cfg, req.body);
    update.updatedBy = req.user?._id;
    // Upsert on the singleton key. slug is unused here but the schema declares
    // uuid unique, so $setOnInsert lets mongoose supply the default.
    await mdb.WEB.webSiteSettings.updateOne({ key: 'site' }, { $set: update }, { upsert: true });
    notifyWebRevalidate('site settings updated');
    req.flash('success', 'Site settings saved.');
    res.redirect('/website/settings');
  } catch (err) {
    next(err);
  }
};

// ── Media library ────────────────────────────────────────────────────────────

// Kept in memory: the bytes are re-encoded by sharp and stored in Mongo, so
// they never touch the container filesystem, which does not survive a redeploy.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: webMediaService.fileFilter,
  // Generous, because this is the *source* file. What gets stored is whatever
  // processImage brings it down to, which is capped at 300KB.
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** One page of the grid. The form pickers still get the full list via mediaChoices. */
const MEDIA_PAGE_SIZE = 24;

/** Escape a user string for use inside a case-insensitive RegExp. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const getMedia = async (req, res, next) => {
  try {
    const q = str(req.query.q);
    const filter = q
      ? { $or: ['filename', 'originalName', 'alt'].map((f) => ({ [f]: new RegExp(escapeRegex(q), 'i') })) }
      : {};

    const total = await mdb.WEB.webMedia.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE));
    // Clamp rather than 404: a search that shrinks the result set below the page
    // someone was on should land them on the last real page, not an error.
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);

    const media = await mdb.WEB.webMedia.find(filter)
      .select('-bytes')
      .sort({ createdAt: -1 })
      .skip((page - 1) * MEDIA_PAGE_SIZE)
      .limit(MEDIA_PAGE_SIZE)
      .lean();

    // Only the images on this page need their usage resolved, but the content
    // collections are small enough that one scan is cheaper than a query each.
    const usageMap = await buildUsageMap();
    const usage = {};
    media.forEach((m) => { usage[m.uuid] = usageMap.get(m.uuid) || []; });

    res.render('tailwindcss/website/media', {
      title: 'Media Library',
      media,
      maxBytes: webMediaService.MAX_BYTES,
      usage,
      q,
      page,
      totalPages,
      total,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Serves an image to the editor itself.
 *
 * Separate from the public /api/web/media/:uuid route on purpose: this one is
 * behind the admin session and shows drafts, so a photograph can be reviewed in
 * the form before anyone outside the company can see it.
 */
export const getMediaFile = async (req, res, next) => {
  try {
    const doc = await mdb.WEB.webMedia.findOne({ uuid: req.params.uuid }).select('bytes mime hash').lean();
    if (!doc || !doc.bytes) return res.status(404).end();
    res.set('Content-Type', doc.mime);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(doc.bytes.buffer || doc.bytes));
  } catch (err) {
    next(err);
  }
};

/** Re-encode one uploaded file into a stored, deduped webMedia record. */
async function storeUpload(file, { alt = '', createdBy } = {}) {
  const processed = await webMediaService.processImage(file.buffer, file.originalname);

  // Same bytes as something already here — hand back the existing record rather
  // than storing a second copy for the mirror to fetch again.
  const existing = await mdb.WEB.webMedia.findOne({ hash: processed.hash }).select('uuid filename').lean();
  if (existing) return { doc: existing, duplicate: true, processed };

  const doc = await mdb.WEB.webMedia.create({
    filename: processed.filename,
    originalName: file.originalname,
    mime: processed.mime,
    bytes: processed.bytes,
    size: processed.size,
    width: processed.width,
    height: processed.height,
    hash: processed.hash,
    alt: String(alt || '').trim(),
    // Images are published immediately: an unpublished image referenced by
    // a published page renders as a hole on the live site, and the media
    // library is not itself a public listing.
    status: 'published',
    publishedAt: new Date(),
    createdBy,
    updatedBy: createdBy,
  });
  return { doc, duplicate: false, processed };
}

// csrfService.validate runs AFTER multer: the global CSRF middleware cannot see
// a multipart body, so the token is only readable once multer has parsed it.
export const postMediaUpload = [
  upload.array('images', 12),
  csrfService.validate,
  async (req, res, next) => {
    try {
      const files = req.files || [];
      if (!files.length) {
        req.flash('error', 'Choose at least one image to upload.');
        return res.redirect('/website/media');
      }
      // Alt describes one photograph, so it only makes sense to apply the field
      // when a single image is uploaded. A batch gets its alt text added after,
      // per image, from the grid.
      const alt = files.length === 1 ? str(req.body.alt) : '';

      let uploaded = 0;
      let duplicates = 0;
      const failed = [];
      for (const file of files) {
        try {
          const { duplicate, processed } = await storeUpload(file, { alt, createdBy: req.user?._id });
          if (duplicate) { duplicates += 1; continue; }
          uploaded += 1;
          logger.info('[website] media uploaded', {
            filename: processed.filename, from: `${file.size}b`, to: `${processed.size}b`,
          });
        } catch (err) {
          failed.push(file.originalname);
          logger.warn('[website] media upload failed', { file: file.originalname, error: err.message });
        }
      }

      if (uploaded) notifyWebRevalidate('media uploaded');

      const parts = [];
      if (uploaded) parts.push(`${uploaded} uploaded`);
      if (duplicates) parts.push(`${duplicates} already in the library`);
      if (failed.length) parts.push(`${failed.length} failed (${failed.join(', ')})`);
      req.flash(failed.length ? 'error' : 'success', `Media upload: ${parts.join(', ') || 'nothing to do'}.`);
      res.redirect('/website/media');
    } catch (err) {
      next(err);
    }
  },
];

/**
 * Edit an image's default alt text in place.
 *
 * A plain urlencoded POST, so the global CSRF middleware guards it — no multer,
 * no per-route revalidation exception. The default alt is what the manifest
 * publishes and what a usage falls back to when it supplies none, so a change
 * here can change the public site: revalidate.
 */
export const postMediaUpdate = async (req, res, next) => {
  try {
    const doc = await mdb.WEB.webMedia.findOne({ uuid: req.params.uuid }).select('uuid').lean();
    if (!doc) {
      return next(Object.assign(new Error('Image not found'), { statusCode: 404 }));
    }
    await mdb.WEB.webMedia.updateOne(
      { uuid: doc.uuid },
      { $set: { alt: str(req.body.alt), updatedBy: req.user?._id } },
    );
    notifyWebRevalidate('media alt updated');
    req.flash('success', 'Alt text saved.');
    res.redirect('/website/media');
  } catch (err) {
    next(err);
  }
};

/**
 * Replace an image with a new upload, keeping every page that used it pointed at
 * the replacement.
 *
 * The replacement is a NEW record with a new uuid — never a rewrite of the old
 * bytes in place. The public API caches /api/web/media/:uuid as immutable for a
 * year (see webApiController.js), so reusing a uuid for different bytes would
 * serve the old image from any cache in front of heroncs.co.uk. Instead:
 *   1. store the new file (deduped by hash),
 *   2. repoint every reference from the old uuid to the new one,
 *   3. delete the old record.
 * The result is a true replacement — same pages, same alt text — with a clean
 * cache story.
 */
export const postMediaReplace = [
  upload.single('image'),
  csrfService.validate,
  async (req, res, next) => {
    try {
      const oldDoc = await mdb.WEB.webMedia.findOne({ uuid: req.params.uuid }).select('uuid filename alt').lean();
      if (!oldDoc) {
        return next(Object.assign(new Error('Image not found'), { statusCode: 404 }));
      }
      if (!req.file) {
        req.flash('error', 'Choose a replacement image.');
        return res.redirect('/website/media');
      }

      const { doc: newDoc, duplicate } = await storeUpload(req.file, {
        // The replacement inherits the old image's default alt: it stands in for
        // the same thing, and losing the alt on replace would be a silent
        // regression on accessibility the brief treats as content.
        alt: oldDoc.alt,
        createdBy: req.user?._id,
      });

      if (duplicate && newDoc.uuid === oldDoc.uuid) {
        req.flash('success', 'The replacement is identical to the current image — nothing changed.');
        return res.redirect('/website/media');
      }

      const repointed = await repointReferences(oldDoc.uuid, newDoc.uuid, req.user?._id);
      await mdb.WEB.webMedia.deleteOne({ uuid: oldDoc.uuid });
      notifyWebRevalidate('media replaced');

      const where = repointed ? ` and updated ${repointed} page${repointed === 1 ? '' : 's'}` : '';
      req.flash('success', `Replaced "${oldDoc.filename}"${where}.`);
      res.redirect('/website/media');
    } catch (err) {
      next(err);
    }
  },
];

/**
 * Delete an image, refusing by default when a page still uses it.
 *
 * A published page referencing a deleted uuid renders as a hole on the live
 * site, so the usual path blocks and names the pages instead. `force=1` (the
 * grid's "Delete anyway") overrides for the case where the editor means it.
 */
export const postMediaDelete = async (req, res, next) => {
  try {
    const doc = await mdb.WEB.webMedia.findOne({ uuid: req.params.uuid }).select('uuid filename').lean();
    if (!doc) {
      req.flash('error', 'Image not found — it may already have been deleted.');
      return res.redirect('/website/media');
    }

    const usages = await usageFor(doc.uuid);
    if (usages.length && req.body.force !== '1') {
      const where = usages.map((u) => `${u.title} (${u.label})`).join(', ');
      req.flash(
        'error',
        `"${doc.filename}" is used on ${usages.length} page${usages.length === 1 ? '' : 's'}: ${where}. `
        + 'Remove it from those pages first, or use “Delete anyway”.',
      );
      return res.redirect('/website/media');
    }

    await mdb.WEB.webMedia.deleteOne({ uuid: doc.uuid });
    notifyWebRevalidate('media deleted');
    req.flash('success', usages.length
      ? `Deleted "${doc.filename}". ${usages.length} page${usages.length === 1 ? '' : 's'} now reference a missing image — fix those next.`
      : `Deleted "${doc.filename}".`);
    res.redirect('/website/media');
  } catch (err) {
    next(err);
  }
};

export default {
  getList, getCreate, postCreate, getEdit, postEdit,
  postPublish, postUnpublish, postDelete,
  getSettings, postSettings,
  getMedia, getMediaFile, postMediaUpload, postMediaUpdate, postMediaReplace, postMediaDelete,
};
