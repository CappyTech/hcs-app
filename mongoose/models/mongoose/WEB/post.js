/**
 * A blog post on heroncs.co.uk/blog. Mirrors hcs-web's services/blogData.js.
 *
 * `author` is free text rather than a ref to the user who wrote it: the byline
 * on the public site is usually "HCS Team", not the individual who typed it.
 * The individual is recorded in updatedBy and in the audit trail.
 */
import mongoose from 'mongoose';
import { publishableFields } from '../../webContentFields.js';

const postSchema = new mongoose.Schema({
  ...publishableFields(),
  slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  title: { type: String, required: true, trim: true },
  excerpt: { type: String, trim: true, default: '' },
  contentHtml: { type: String, default: '' },
  author: { type: String, trim: true, default: 'HCS Team' },
  tags: { type: [String], default: [] },
}, { timestamps: true });

export default { modelName: 'webPost', schema: postSchema };
