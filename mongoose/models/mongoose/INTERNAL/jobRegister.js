import mongoose from 'mongoose';
import crypto from 'crypto';

// One row of the Job Register: the plan of what will be in KashFlow, entered
// here first (double entry). It replaces the "Job Reg" workbook, whose two
// sheets are two stages of the same row:
//
//   Quotes 26  → quoteNumber (the KashFlow quote number, 51xxx), quoteDate
//   Job Reg 26 → projectNumber (the KashFlow project number, 41xxx), jobDate,
//                invoiceNumber / invoiceDate (the KashFlow invoice), clientRef
//
// The stage (quoted, won, invoiced, cancelled) is worked out from which of
// these are filled in (jobRegisterService.stageOf), so it can't disagree with
// them. The register page matches each number against the synced REST
// quotes, projects and invoices. KashFlow is only written by the optional
// Create in KashFlow buttons (jobRegisterKashflowService).
const jobRegisterSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  quoteNumber: { type: Number, min: 1 },
  quoteDate: { type: Date },
  projectNumber: { type: Number, min: 1 },
  jobDate: { type: Date },

  site: { type: String, required: [true, 'Enter the site.'], trim: true, maxlength: 300 },
  // The client is a KashFlow customer: its Code is the link, and client holds
  // its Name as it was when chosen (for display and filtering). Rows from
  // before the link may have a client with no customerCode.
  customerCode: { type: String, trim: true, maxlength: 50 },
  client: { type: String, required: [true, 'Choose the client.'], trim: true, maxlength: 200 },
  contact: { type: String, trim: true, maxlength: 200 },
  // Net, as on the spreadsheet and KashFlow's NetAmount
  value: { type: Number, min: 0 },
  description: { type: String, trim: true, maxlength: 300 },
  // The client's own order or PO number (column J on the Job Reg sheet)
  clientRef: { type: String, trim: true, maxlength: 100 },

  invoiceNumber: { type: Number, min: 1 },
  invoiceDate: { type: Date },

  notes: { type: String, trim: true, maxlength: 2000 },
  cancelled: { type: Boolean, default: false },

  // Where the row came from. importId is the workbook upload (workbookImport
  // uuid) that created it; none means it was entered by hand. editedAt is
  // the last time someone saved it from the form. A re-import may overwrite
  // an imported row nobody has edited since; anything else it only fills in.
  importId: { type: String, trim: true },
  importedAt: { type: Date },
  editedAt: { type: Date },

  // The contract that runs the job on site, once it has one. A won job with
  // no contract is a "job for allocation" on the weekly sheet.
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract' },

  // Create in KashFlow: when the quote / project was created there from this
  // row (so it isn't offered again), and the claim held while a create is in
  // flight (so a double press can't make two).
  quoteSentAt: { type: Date },
  projectSentAt: { type: Date },
  quoteSendingAt: { type: Date },
  projectSendingAt: { type: Date },
}, { timestamps: true });

jobRegisterSchema.index({ quoteNumber: 1 }, { unique: true, partialFilterExpression: { quoteNumber: { $type: 'number' } } });
jobRegisterSchema.index({ projectNumber: 1 }, { unique: true, partialFilterExpression: { projectNumber: { $type: 'number' } } });
jobRegisterSchema.index({ invoiceNumber: 1 });
jobRegisterSchema.index({ customerCode: 1 });
jobRegisterSchema.index({ importId: 1 }, { sparse: true });

jobRegisterSchema.pre('validate', function (next) {
  if (this.quoteNumber == null && this.projectNumber == null) {
    return next(new Error('Enter a quote number, a project number, or both.'));
  }
  if (this.invoiceNumber != null && this.projectNumber == null) {
    return next(new Error('An invoiced job needs its project number.'));
  }
  next();
});

export default {
  modelName: 'jobRegister',
  schema: jobRegisterSchema,
};
