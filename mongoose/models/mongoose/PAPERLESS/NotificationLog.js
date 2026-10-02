// mongoose/models/mongoose/PAPERLESS/NotificationLog.js
//
// Every document notification hcs-app sends (or, in shadow mode, would send).
// Paperless migration H2: the partial unique index on (paperlessId, kind) for
// one-shot kinds is what replaces the `notified/*` tags — "exactly once" is a
// database guarantee, not a tag convention. Re-sends to John (`john_resend`)
// are logged every time and are not unique.
import mongoose from 'mongoose';

/** Kinds that may be sent at most once per document. */
export const ONE_SHOT_KINDS = ['new_doc', 'john', 'kashflow', 'statement', 'credit_note'];
/** Kinds logged on every send. */
export const REPEATABLE_KINDS = ['john_resend'];

const ActorSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, default: null },
}, { _id: false });

const ChannelResultSchema = new mongoose.Schema({
  channel: { type: String, enum: ['email', 'discord'] },
  status: { type: String, enum: ['sent', 'shadow', 'skipped', 'failed'] },
  to: { type: String, default: null },
  error: { type: String, default: null },
  at: Date,
}, { _id: false });

const NotificationLogSchema = new mongoose.Schema({
  paperlessId: { type: Number, required: true, index: true },
  kind: { type: String, enum: [...ONE_SHOT_KINDS, ...REPEATABLE_KINDS], required: true },
  // Set from kind on validate; the unique index only covers one-shot rows
  oneShot: { type: Boolean, required: true },
  // claimed → sent | shadow | failed; `recorded` = historical entry from the H7 backfill
  status: { type: String, enum: ['claimed', 'sent', 'shadow', 'failed', 'recorded'], default: 'claimed', index: true },
  mode: { type: String, enum: ['shadow', 'live', null], default: null },
  source: { type: String, enum: ['app', 'backfill'], default: 'app' },
  channels: { type: [ChannelResultSchema], default: [] },
  triggeredBy: { type: ActorSchema, default: null },
  error: { type: String, default: null },
}, { timestamps: true });

NotificationLogSchema.pre('validate', function setOneShot(next) {
  this.oneShot = ONE_SHOT_KINDS.includes(this.kind);
  next();
});

// Partial: only one-shot rows are unique, so john_resend can repeat.
// $eq on a boolean works as a partial filter on every supported MongoDB version.
NotificationLogSchema.index(
  { paperlessId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { oneShot: true }, name: 'one_shot_per_document' },
);

export default {
  modelName: 'NotificationLog',
  schema: NotificationLogSchema,
};
