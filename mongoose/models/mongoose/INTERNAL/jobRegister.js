import mongoose from 'mongoose';
import crypto from 'crypto';

// One job in the Job Register: the plan of what will be in KashFlow, entered
// here first (double entry). It replaces the "Job Reg" workbook.
//
// KashFlow's shape is project (41xxx, the UI calls it a job) → quotes (51xxx)
// → invoices. So a document is one job:
//
//   projectNumber → the KashFlow project, once the job is won
//   quotes[]      → its quotes: usually one, more for variations
//   invoices[]    → its invoices: usually one, more for stage payments
//
// An enquiry is a job with one quote and no project number yet; winning it
// fills projectNumber in on the same document, so its _id and uuid (and the
// attendance booked on it) never change.
//
// The stage (to quote, quoted, won, completed, invoiced, cancelled) is worked
// out from these and the flags below (jobRegisterService.stageOf), so it
// can't disagree with them. The register page matches each number against
// the synced REST quotes, projects and invoices. KashFlow is only written by
// the optional Create in KashFlow buttons, or automatically on a quote added
// or a job won when JOB_REGISTER_KASHFLOW_AUTO is on (jobRegisterKashflowService).

// A quote is to survey and quote (white on the old sheet), quoted and waiting
// for an answer (grey/black), won (yellow) or lost.
export const QUOTE_STATUSES = ['toQuote', 'quoted', 'won', 'lost'];

const quoteSchema = new mongoose.Schema({
  number: { type: Number, min: 1 },
  date: { type: Date },
  // Net, as KashFlow's NetAmount
  value: { type: Number, min: 0 },
  description: { type: String, trim: true, maxlength: 300 },
  status: { type: String, enum: QUOTE_STATUSES, default: 'quoted' },
  notes: { type: String, trim: true, maxlength: 2000 },
  // Create in KashFlow: when this quote was created there from here (so it
  // isn't offered again), and the claim held while a create is in flight
  sentAt: { type: Date },
  sendingAt: { type: Date },
});

const invoiceSchema = new mongoose.Schema({
  number: { type: Number, min: 1, required: [true, 'Enter the invoice number.'] },
  date: { type: Date },
  // Net. Left blank, the invoice is taken to cover the rest of the job.
  value: { type: Number, min: 0 },
  notes: { type: String, trim: true, maxlength: 2000 },
});

const jobRegisterSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },

  projectNumber: { type: Number, min: 1 },
  jobDate: { type: Date },

  site: { type: String, required: [true, 'Enter the site.'], trim: true, maxlength: 300 },
  // The client is a KashFlow customer: its Code is the link, and client holds
  // its Name as it was when chosen (for display and filtering). Rows from
  // before the link may have a client with no customerCode.
  customerCode: { type: String, trim: true, maxlength: 50 },
  client: { type: String, required: [true, 'Choose the client.'], trim: true, maxlength: 200 },
  contact: { type: String, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 300 },
  // The client's own order or PO number (column J on the Job Reg sheet)
  clientRef: { type: String, trim: true, maxlength: 100 },
  // The agreed net value of a job with no quote (a job-only row); a job with
  // quotes is worth its won quotes
  value: { type: Number, min: 0 },

  quotes: { type: [quoteSchema], default: [] },
  invoices: { type: [invoiceSchema], default: [] },

  notes: { type: String, trim: true, maxlength: 2000 },
  cancelled: { type: Boolean, default: false },

  // The state the workbook's row colours gave (or set on the form). won is a
  // job whose quote is won but may not have its project number yet; completed
  // is a green job (done, maybe not invoiced yet); inKashflow is an orange
  // project number (entered in KashFlow as a project).
  won: { type: Boolean, default: false },
  completed: { type: Boolean, default: false },
  inKashflow: { type: Boolean, default: false },

  // Where the job came from. importId is the workbook upload (workbookImport
  // uuid) that created it; none means it was entered by hand. editedAt is
  // the last time someone saved it from a form. A re-import may overwrite
  // an imported job nobody has edited since; anything else it only fills in.
  importId: { type: String, trim: true },
  importedAt: { type: Date },
  editedAt: { type: Date },

  // The contract that runs the job on site, once it has one. A won job with
  // no contract is a "job for allocation" on the weekly sheet.
  contractId: { type: mongoose.Schema.Types.ObjectId, ref: 'contract' },

  // Create in KashFlow (project): when it was created there from here, and
  // the claim held while a create is in flight (so a double press can't make
  // two). Each quote holds its own.
  projectSentAt: { type: Date },
  projectSendingAt: { type: Date },
}, { timestamps: true });

jobRegisterSchema.index({ projectNumber: 1 }, { unique: true, partialFilterExpression: { projectNumber: { $type: 'number' } } });
// A quote number belongs to one job. (A unique multikey index doesn't stop
// one job holding it twice: the pre-validate check does.)
jobRegisterSchema.index({ 'quotes.number': 1 }, { unique: true, partialFilterExpression: { 'quotes.number': { $type: 'number' } } });
jobRegisterSchema.index({ 'invoices.number': 1 });
jobRegisterSchema.index({ customerCode: 1 });
jobRegisterSchema.index({ importId: 1 }, { sparse: true });

/** The first number in `numbers` seen twice, or null. Pure. */
export function repeatedNumber(numbers = []) {
  const seen = new Set();
  for (const n of numbers) {
    if (n == null) continue;
    if (seen.has(Number(n))) return Number(n);
    seen.add(Number(n));
  }
  return null;
}

/** Why a job (document or plain object) isn't valid as a whole, or null. Pure. */
export function jobProblem(job) {
  const quotes = job.quotes || [];
  const invoices = job.invoices || [];
  if (job.projectNumber == null && !quotes.some((q) => q.number != null)) {
    return 'Enter a quote number, a project number, or both.';
  }
  if (invoices.length && job.projectNumber == null) return 'An invoiced job needs its project number.';
  const q = repeatedNumber(quotes.map((x) => x.number));
  if (q != null) return `Quote ${q} is on this job twice.`;
  const i = repeatedNumber(invoices.map((x) => x.number));
  if (i != null) return `Invoice ${i} is on this job twice.`;
  return null;
}

jobRegisterSchema.pre('validate', function (next) {
  const problem = jobProblem(this);
  if (problem) return next(new Error(problem));
  next();
});

export default {
  modelName: 'jobRegister',
  schema: jobRegisterSchema,
};
