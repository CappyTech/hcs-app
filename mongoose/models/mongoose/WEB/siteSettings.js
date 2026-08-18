/**
 * Site identity, contact details, SEO defaults and statutory disclosure —
 * hcs-web's services/siteData.js.
 *
 * A singleton: exactly one document, found by `key: 'site'`. It is modelled as
 * a collection rather than a config file so it carries the same audit trail and
 * the same draft/publish gate as everything else in this namespace — the footer
 * and every page's <head> render from it, so a bad edit is site-wide.
 *
 * Offices are an ordered array, not three named keys as on the live site
 * (liverpool/cheshire/garston). getOffices() there already flattens them into a
 * list for the footer grid, and the array is what lets one be added or removed
 * without a code change. Note the brief flags the Cheshire address as possible
 * dummy data — [TO SUPPLY] confirmation, which is now an edit rather than a PR.
 */
import mongoose from 'mongoose';
import { publishableFields } from '../../webContentFields.js';

const addressSchema = new mongoose.Schema({
  line1: { type: String, trim: true, default: '' },
  line2: { type: String, trim: true, default: '' },
  line3: { type: String, trim: true, default: '' },
  line4: { type: String, trim: true, default: '' },
  postcode: { type: String, trim: true, default: '' },
}, { _id: false });

const officeSchema = new mongoose.Schema({
  label: { type: String, trim: true, default: '' },
  phone: { type: String, trim: true, default: '' },
  address: { type: addressSchema, default: () => ({}) },
}, { _id: false });

const hoursSchema = new mongoose.Schema({
  days: { type: String, trim: true, default: '' },
  time: { type: String, trim: true, default: '' },
}, { _id: false });

const siteSettingsSchema = new mongoose.Schema({
  ...publishableFields(),
  key: { type: String, default: 'site', unique: true, immutable: true },

  name: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, default: '' },
  tagline: { type: String, trim: true, default: '' },

  // Statutory disclosure. companyNumber is required on the site by law;
  // vatNumber is empty until confirmed VAT-registered.
  companyNumber: { type: String, trim: true, default: '' },
  registrationCountry: { type: String, trim: true, default: '' },
  companyType: { type: String, trim: true, default: '' },
  vatNumber: { type: String, trim: true, default: '' },

  // SEO / social. ogImage is a webMedia uuid; head.ejs skips the social-share
  // tag entirely when it is empty rather than linking a 404.
  robots: { type: String, trim: true, default: 'index, follow' },
  ogType: { type: String, trim: true, default: 'website' },
  ogImage: { type: String, trim: true, default: '' },
  twitterCard: { type: String, trim: true, default: 'summary_large_image' },
  themeColor: { type: String, trim: true, default: '#ffffff' },
  locale: { type: String, trim: true, default: 'en_GB' },

  // Social handles. Empty means the footer hides that link rather than
  // rendering one that goes nowhere.
  twitterHandle: { type: String, trim: true, default: '' },
  instagramHandle: { type: String, trim: true, default: '' },
  facebookHandle: { type: String, trim: true, default: '' },
  linkedinHandle: { type: String, trim: true, default: '' },

  inboxMonitored: { type: String, trim: true, default: '' },
  inboxResponse: { type: String, trim: true, default: '' },

  hours: { type: [hoursSchema], default: [] },
  offices: { type: [officeSchema], default: [] },
}, { timestamps: true });

export default { modelName: 'webSiteSettings', schema: siteSettingsSchema };
