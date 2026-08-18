/**
 * A service card on heroncs.co.uk/services. Mirrors hcs-web's servicesData.js.
 *
 * `href` carries the site's own convention: anything other than /contact means
 * the service has a dedicated page, which is also what promotes it from an
 * enquire-only text card to a linked card in the footer (getFooterServices).
 * Keep that meaning — the footer is generated from it.
 */
import mongoose from 'mongoose';
import { publishableFields, imageRef } from '../../webContentFields.js';

const serviceSchema = new mongoose.Schema({
  ...publishableFields(),
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: '' },
  image: { ...imageRef() },
  href: { type: String, trim: true, default: '/contact' },
  cta: { type: String, trim: true, default: 'Enquire' },
  // Page-level SEO for a dedicated service page; falls back to title/description.
  pageTitle: { type: String, trim: true, default: '' },
  metaDescription: { type: String, trim: true, default: '' },
  contentHtml: { type: String, default: '' },
}, { timestamps: true });

export default { modelName: 'webService', schema: serviceSchema };
