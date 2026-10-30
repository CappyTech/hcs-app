// mongoose/models/mongoose/PAPERLESS/MailRuleSnapshot.js
//
// The Paperless mail rules as last seen, saved only when something changed
// (plus the first read), so the rows double as a dated history of how emailed
// documents are filed. Paperless owns the rules; this is a read-only copy of
// their config — addresses, type, tags, scope, enabled — never document
// contents. The newest row is what the next read is compared against.
import mongoose from 'mongoose';

const RuleSchema = new mongoose.Schema({
  ruleId: Number,
  name: String,
  account: String,
  to: String,
  documentTypeId: Number,
  documentType: String,
  tagIds: [Number],
  tags: [String],
  scope: Number,
  attachmentFilter: String,
  enabled: Boolean,
}, { _id: false });

const ChangeSchema = new mongoose.Schema({
  ruleId: Number,
  kind: String,    // added | removed | changed
  field: String,   // to | documentType | tags | scope | attachmentFilter | enabled (changed only)
  from: mongoose.Schema.Types.Mixed,
  to: mongoose.Schema.Types.Mixed,
  summary: String, // e.g. "bank@ rule disabled"
}, { _id: false });

const MailRuleSnapshotSchema = new mongoose.Schema({
  takenAt: { type: Date, required: true, index: true },
  baseline: { type: Boolean, default: false }, // the first read: nothing to compare with
  rules: { type: [RuleSchema], default: [] },
  changes: { type: [ChangeSchema], default: [] },
}, { timestamps: true });

export default {
  modelName: 'MailRuleSnapshot',
  schema: MailRuleSnapshotSchema,
};
