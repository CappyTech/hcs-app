/**
 * An image used on heroncs.co.uk. The bytes live in this document.
 *
 * Storing them in Mongo rather than on the storage volume is deliberate: the
 * volume at ~/docker/app/storage is in none of the five nightly backup jobs,
 * while Mongo is dumped at 02:00 — so bytes here are backed up, survive a
 * `docker compose pull` redeploy, and need no sixth cron job. Web images are
 * capped well under Mongo's 16MB document limit by the resize on upload.
 *
 * The audit plugin's sanitize() already renders Buffers as "[Buffer N bytes]",
 * so attaching the trail to this namespace does not copy every image into the
 * audit log.
 *
 * SVG is rejected on upload. These files are served to a third-party origin
 * (heroncs.co.uk mirrors them), and an SVG is a script-bearing document.
 */
import mongoose from 'mongoose';
import { publishableFields } from '../../webContentFields.js';

const mediaSchema = new mongoose.Schema({
  ...publishableFields(),
  // Normalised on upload: lowercased, spaces to hyphens. The originals on the
  // live site contain spaces, which is what makes them awkward to reference.
  filename: { type: String, required: true, trim: true },
  originalName: { type: String, trim: true, default: '' },
  mime: { type: String, required: true, trim: true },
  bytes: { type: Buffer, required: true },
  size: { type: Number, default: 0 },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  // Default alt, used when a usage does not supply its own. A usage-specific
  // alt on the referencing record always wins — see imageRef().
  alt: { type: String, trim: true, default: '' },
  // Content hash, served as the ETag and used to dedupe re-uploads.
  hash: { type: String, trim: true, default: '', index: true },
}, { timestamps: true });

export default { modelName: 'webMedia', schema: mediaSchema };
