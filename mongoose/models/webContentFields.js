/**
 * Shared field definitions for the WEB namespace — the content hcs-web renders.
 *
 * Deliberately NOT inside models/mongoose/WEB/: that directory is scanned file
 * by file by createNamespace() in mongooseDatabaseService.js, and anything there
 * that does not export { modelName, schema } is logged as a skipped model.
 *
 * Every WEB model carries the publication fields below. `status` is the whole
 * safety mechanism of this module: the public API in webApiController.js
 * filters on `status: 'published'`, so a record being visible on heroncs.co.uk
 * is a property of the record, never of the route that happened to read it.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';

export const STATUSES = ['draft', 'published'];

/** uuid + draft/publish + ordering + authorship, spread into every WEB schema. */
export function publishableFields() {
  return {
    uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
    status: { type: String, enum: STATUSES, default: 'draft', index: true },
    // Stamped by the controller on the draft → published transition, and left
    // alone afterwards: it is the date the site shows, not a modification time.
    publishedAt: { type: Date, default: null },
    // Ascending. Ties fall back to the model's own natural order.
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
  };
}

/**
 * A reference to an uploaded image. Stored as the media record's uuid plus its
 * alt text, because alt is a property of *this usage* of the image, not of the
 * file: the same photo is "damaged fencing before works" on one page and
 * "boundary fencing" on another. The brief requires real alt text everywhere.
 */
export function imageRef() {
  return {
    media: { type: String, default: '' },   // webMedia.uuid, '' = no image
    alt: { type: String, trim: true, default: '' },
  };
}
