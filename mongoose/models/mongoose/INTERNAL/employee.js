import mongoose from 'mongoose';
import crypto from 'crypto';

const employeeSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  name: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  phoneNumber: { type: String },
  contactName: { type: String },
  contactNumber: { type: String },
  position: { type: String },
  department: {
    type: String,
    enum: ['Landscaping', 'Office', 'Other'],
    default: null
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  type: {
    type: String,
    enum: ['full-time', 'part-time'],
    default: 'full-time'
  },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
  hireDate: { type: Date, default: Date.now },
  hourlyRate: { type: mongoose.Decimal128, default:0 },
  dailyRate: { type: mongoose.Decimal128, default:0 },
  weeklyRate: { type: mongoose.Decimal128, default:0 },
  monthlyRate: { type: mongoose.Decimal128, default:0 },
  yearlyRate: { type: mongoose.Decimal128, default:0 }
}, {
  timestamps: true
});

// Contract terms and holiday policy attachments (extensible without breaking existing docs)
employeeSchema.add({
  // Contract terms
  contract: {
    termsType: { type: String, enum: ['permanent', 'temporary', 'zero-hours', 'fixed-term'], default: 'permanent' },
    hoursPerWeek: { type: Number, default: null },
    workingDaysPerWeek: { type: Number, default: 5 },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    noticePeriodWeeks: { type: Number, default: null }
  },
  // Holiday policy (per employee override)
  holidayPolicy: {
    entitlementType: { type: String, enum: ['days', 'hours'], default: 'days' },
    entitlementValue: { type: Number, default: 28 }, // UK statutory max incl. bank holidays for full-time
    includesBankHolidays: { type: Boolean, default: true },
    accrualMethod: { type: String, enum: ['fixed', 'per-hour', 'per-day'], default: 'fixed' },
    accrualPercent: { type: Number, default: 12.07 },
    carryOverMaxDays: { type: Number, default: 0 },
    carryOverMaxHours: { type: Number, default: 0 }
  }
});

// Define which rate is authoritative for calculations
employeeSchema.add({
  definedRate: { type: String, enum: ['hourly','daily', 'weekly', 'monthly', 'yearly'], default: 'weekly' }
});

// Right-to-work check (hrComplianceService reminds admins before expiryDate)
employeeSchema.add({
  rightToWork: {
    documentType: { type: String, enum: ['passport', 'birth-certificate', 'visa', 'biometric-residence-permit', 'share-code', 'other', null], default: null },
    reference: { type: String, default: null },
    checkedDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null }
  }
});

// IR35 off-payroll: employee is also a CIS subcontractor
employeeSchema.add({
  ir35: { type: Boolean, default: false },
  subcontractorSupplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier', default: null }
});

// ── Payroll / PAYE fields ────────────────────────────────────────────────────
employeeSchema.add({
  payroll: {
    // HMRC identifiers
    niNumber: { type: String, default: null },           // encrypted at rest (AES-256-CBC via encryptionService)
    niCategory: {
      type: String,
      enum: ['A', 'B', 'C', 'H', 'J', 'M', 'Z'],
      default: 'A'
    },
    taxCode: { type: String, default: '1257L' },         // e.g. 1257L, BR, D0, NT
    taxBasis: {
      type: String,
      enum: ['cumulative', 'week1/month1'],
      default: 'cumulative'
    },
    payeStartDate: { type: Date, default: null },
    payrollId: { type: String, default: null },          // internal payroll number
    starterDeclaration: {
      type: String,
      enum: ['A', 'B', 'C', null],
      default: null
    },

    // Year-to-date carry-forward (seeded from prior system at start)
    ytdGrossPay:     { type: mongoose.Decimal128, default: 0 },
    ytdTaxPaid:      { type: mongoose.Decimal128, default: 0 },
    ytdEmployeeNI:   { type: mongoose.Decimal128, default: 0 },
    ytdEmployerNI:   { type: mongoose.Decimal128, default: 0 },

    // Student / postgrad loan
    studentLoanPlan: {
      type: String,
      enum: ['none', 'Plan1', 'Plan2', 'Plan4', 'Postgrad'],
      default: 'none'
    },
    postgradLoan: { type: Boolean, default: false },

    // Auto-enrolment pension
    pensionEnrolled:      { type: Boolean, default: false },
    pensionOptOutDate:    { type: Date, default: null },
    employeePensionRate:  { type: mongoose.Decimal128, default: null },  // % override; null → use config default
    employerPensionRate:  { type: mongoose.Decimal128, default: null },  // % override; null → use config default
    salarySacrifice:      { type: Boolean, default: false }              // true → employee pension reduces taxable gross
  }
});

employeeSchema.pre('validate', function (next) {
  if (this.ir35 && !this.subcontractorSupplierId) {
    return next(new Error('IR35 employees must be linked to a supplier record (subcontractorSupplierId).'));
  }
  if (!this.ir35 && this.subcontractorSupplierId) {
    return next(new Error('subcontractorSupplierId can only be set when ir35 is true.'));
  }
  next();
});

// Helper: convert Decimal128 to Number safely
function d2n(v) {
  if (v == null) return null;
  try { return typeof v === 'object' && v.toString ? Number(v.toString()) : Number(v); } catch (_) { return Number(v); }
}

// Compute all rate fields from a base value and context
function computeRatesFrom(baseKind, baseValue, ctx) {
  const workingDays = Number.isFinite(ctx.workingDaysPerWeek) && ctx.workingDaysPerWeek > 0 ? ctx.workingDaysPerWeek : 5;
  const hoursPerWeek = Number.isFinite(ctx.hoursPerWeek) && ctx.hoursPerWeek > 0 ? ctx.hoursPerWeek : null;
  const weeksPerYear = 52;
  const monthsPerYear = 12;

  let daily = null, weekly = null, monthly = null, yearly = null, hourly = null;

  switch (baseKind) {
    case 'daily':
      daily = baseValue;
      weekly = daily * workingDays;
      yearly = weekly * weeksPerYear;
      monthly = yearly / monthsPerYear;
      if (hoursPerWeek) {
        const hoursPerDay = hoursPerWeek / workingDays;
        if (hoursPerDay > 0) hourly = daily / hoursPerDay;
      }
      break;
    case 'weekly':
      weekly = baseValue;
      daily = weekly / workingDays;
      yearly = weekly * weeksPerYear;
      monthly = yearly / monthsPerYear;
      if (hoursPerWeek && hoursPerWeek > 0) hourly = weekly / hoursPerWeek;
      break;
    case 'monthly':
      monthly = baseValue;
      yearly = monthly * monthsPerYear;
      weekly = yearly / weeksPerYear;
      daily = weekly / workingDays;
      if (hoursPerWeek && hoursPerWeek > 0) hourly = weekly / hoursPerWeek;
      break;
    case 'yearly':
      yearly = baseValue;
      weekly = yearly / weeksPerYear;
      daily = weekly / workingDays;
      monthly = yearly / monthsPerYear;
      if (hoursPerWeek && hoursPerWeek > 0) hourly = weekly / hoursPerWeek;
      break;
    case 'hourly':
      hourly = baseValue;
      if (hoursPerWeek && hoursPerWeek > 0) {
        weekly = hourly * hoursPerWeek;
        daily = weekly / workingDays;
        yearly = weekly * weeksPerYear;
        monthly = yearly / monthsPerYear;
      }
      break;
    default:
      break;
  }

  const toD128 = (n) => (Number.isFinite(n) ? mongoose.Types.Decimal128.fromString(n.toFixed(2)) : undefined);
  return {
    dailyRate: toD128(daily),
    weeklyRate: toD128(weekly),
    monthlyRate: toD128(monthly),
    yearlyRate: toD128(yearly),
    hourlyRate: Number.isFinite(hourly) ? mongoose.Types.Decimal128.fromString(hourly.toFixed(4)) : undefined
  };
}

// Pre-validate: enforce that only the definedRate numeric change is accepted; others are derived
employeeSchema.pre('validate', function (next) {
  try {
    const defined = this.definedRate || 'weekly';
    // Determine if a rate field was modified
    const modified = {
      dailyRate: this.isModified('dailyRate'),
      weeklyRate: this.isModified('weeklyRate'),
      monthlyRate: this.isModified('monthlyRate'),
      yearlyRate: this.isModified('yearlyRate'),
      hourlyRate: this.isModified('hourlyRate')
    };

    // Base value comes from the defined rate field; if none modified, on create use existing value
    let baseValue = null;
    if (defined === 'daily') baseValue = d2n(this.dailyRate);
    else if (defined === 'weekly') baseValue = d2n(this.weeklyRate);
    else if (defined === 'monthly') baseValue = d2n(this.monthlyRate);
    else if (defined === 'yearly') baseValue = d2n(this.yearlyRate);
    else if (defined === 'hourly') baseValue = d2n(this.hourlyRate);

    // If a non-defined rate was modified, ignore it by recomputing from base
    const nonDefinedModified = Object.entries(modified).some(([k, v]) => {
      if (!v) return false;
      if (defined === 'daily' && k === 'dailyRate') return false;
      if (defined === 'weekly' && k === 'weeklyRate') return false;
      if (defined === 'monthly' && k === 'monthlyRate') return false;
      if (defined === 'yearly' && k === 'yearlyRate') return false;
      if (defined === 'hourly' && k === 'hourlyRate') return false;
      return true;
    });

    // If no base value yet (e.g., first set was made against non-defined), infer base from whichever rate was changed and then require definedRate to be updated first
    if (baseValue == null) {
      // If user changed a specific rate but didn't change definedRate accordingly, block with guidance
      const changedKind = modified.dailyRate ? 'daily' : modified.weeklyRate ? 'weekly' : modified.monthlyRate ? 'monthly' : modified.yearlyRate ? 'yearly' : modified.hourlyRate ? 'hourly' : null;
      if (changedKind && changedKind !== defined) {
        return next(new Error(`To change ${changedKind} pay, set definedRate to '${changedKind}' first.`));
      }
      // Else proceed (create without base) — nothing to compute
      return next();
    }

    // Compute all rates from the base and overwrite non-defined fields
    const ctx = {
      workingDaysPerWeek: this.contract && this.contract.workingDaysPerWeek,
      hoursPerWeek: this.contract && this.contract.hoursPerWeek
    };
    const computed = computeRatesFrom(defined, baseValue, ctx);

    // Apply computed values, but leave the defined field as-is
    if (defined !== 'daily') this.dailyRate = computed.dailyRate ?? this.dailyRate;
    if (defined !== 'weekly') this.weeklyRate = computed.weeklyRate ?? this.weeklyRate;
    if (defined !== 'monthly') this.monthlyRate = computed.monthlyRate ?? this.monthlyRate;
    if (defined !== 'yearly') this.yearlyRate = computed.yearlyRate ?? this.yearlyRate;
    if (defined !== 'hourly') this.hourlyRate = computed.hourlyRate ?? this.hourlyRate;

    // If user tried changing non-defined rate directly, we neutralize by overwriting from base
    if (nonDefinedModified) {
      // No error; silently align to definedRate rule
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

export default {
  modelName: 'employee',
  schema: employeeSchema
};
