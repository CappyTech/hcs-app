/**
 * A project story on heroncs.co.uk/studies.
 *
 * Field names mirror hcs-web's services/caseStudyData.js exactly, so the site's
 * service, controller and views need no change when the source swaps from that
 * file to this collection.
 *
 * The brief's format is header (location + scope) → before photo + problem →
 * after photo + result → optional social-value note. `client` is intentionally
 * optional and empty by default: naming a housing association on a public site
 * needs their permission, and a blank is correct until it is given.
 */
import mongoose from 'mongoose';
import { publishableFields, imageRef } from '../../webContentFields.js';

const galleryItemSchema = new mongoose.Schema({
  ...imageRef(),
  caption: { type: String, trim: true, default: '' },
}, { _id: false });

const panelSchema = new mongoose.Schema({
  ...imageRef(),
  caption: { type: String, trim: true, default: '' },
}, { _id: false });

const caseStudySchema = new mongoose.Schema({
  ...publishableFields(),
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  title: { type: String, required: true, trim: true },
  client: { type: String, trim: true, default: '' },
  location: { type: String, trim: true, default: '' },
  scope: { type: String, trim: true, default: '' },
  excerpt: { type: String, trim: true, default: '' },
  // Thumbnail for the /studies index. Null renders a text panel rather than an
  // unrelated photo — see the Jobs Plus entry, which has no usable image yet.
  card: { ...imageRef() },
  before: { type: panelSchema, default: () => ({}) },
  after: { type: panelSchema, default: () => ({}) },
  gallery: { type: [galleryItemSchema], default: [] },
  // Rich text (Quill). Named contentHtml because securityService's
  // RICH_TEXT_FIELDS already whitelists that key for the XSS sanitiser.
  contentHtml: { type: String, default: '' },
  socialValue: { type: String, trim: true, default: '' },
}, { timestamps: true });

export default { modelName: 'webCaseStudy', schema: caseStudySchema };
