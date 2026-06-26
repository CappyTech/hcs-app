'use strict';

const path = require('path');
const multer = require('multer');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const csrfService = require('../../services/csrfService');
const { POLICY_CATEGORIES } = require('../models/mongoose/INTERNAL/policyDocument');

// contentHtml is pre-sanitised by the global xssSanitize middleware
// (securityService.js) with the richTextXssOptions whitelist.
// No additional filterXSS call is needed here.

// ── Logo upload storage ──────────────────────────────────────────────────────
// Keep the upload in memory so the bytes can be persisted to MongoDB. Writing
// to the container filesystem (public/images) does not survive redeploys.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpeg|jpg|png|gif|svg|webp)$/i;
    const allowedMime = /image\//;
    const valid = allowed.test(path.extname(file.originalname)) && allowedMime.test(file.mimetype);
    cb(valid ? null : new Error('Only image files are allowed for the logo.'), valid);
  },
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

// ── Hub ──────────────────────────────────────────────────────────────────────
exports.getIndex = async (req, res, next) => {
  try {
    const [letterhead, policyCount] = await Promise.all([
      mdb.INTERNAL.letterhead.findOne().select('-logoData').lean(),
      mdb.INTERNAL.policyDocument.countDocuments(),
    ]);
    res.render('tailwindcss/company-docs/index', {
      title: 'Company Documents',
      letterhead,
      policyCount,
    });
  } catch (err) {
    next(err);
  }
};

// ── Letterhead settings ──────────────────────────────────────────────────────
exports.getLetterhead = async (req, res, next) => {
  try {
    const letterhead = await mdb.INTERNAL.letterhead.findOne().select('-logoData').lean();
    res.render('tailwindcss/company-docs/letterhead', {
      title: 'Letterhead Settings',
      letterhead: letterhead || {},
    });
  } catch (err) {
    next(err);
  }
};

// Streams the stored logo bytes. The letterhead.logoPath the views render
// points here (with a cache-busting query string set on each upload).
exports.getLetterheadLogo = async (req, res, next) => {
  try {
    const letterhead = await mdb.INTERNAL.letterhead.findOne().select('logoData logoMime');
    if (!letterhead || !letterhead.logoData || !letterhead.logoData.length) {
      return res.status(404).end();
    }
    res.set('Content-Type', letterhead.logoMime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(letterhead.logoData);
  } catch (err) {
    next(err);
  }
};

exports.postLetterhead = [
  logoUpload.single('logo'),
  csrfService.validate,
  async (req, res, next) => {
    try {
      const fields = [
        'companyName', 'tagline', 'addressLine1', 'addressLine2',
        'town', 'county', 'postcode', 'phone', 'email',
        'website', 'registrationNumber', 'vatNumber', 'footerText',
      ];
      const update = {};
      for (const f of fields) {
        if (req.body[f] !== undefined) update[f] = req.body[f];
      }
      if (req.file) {
        update.logoData = req.file.buffer;
        update.logoMime = req.file.mimetype;
        // Cache-busting query string so a replaced logo refreshes immediately.
        update.logoPath = `/company-docs/letterhead/logo?v=${Date.now()}`;
      }
      await mdb.INTERNAL.letterhead.findOneAndUpdate({}, update, { upsert: true, new: true });
      req.session.successMessage = 'Letterhead settings saved.';
      res.redirect('/company-docs/letterhead');
    } catch (err) {
      next(err);
    }
  },
];

// ── Policy list ──────────────────────────────────────────────────────────────
// Category groups display in the order they are declared on the model.
const POLICY_CATEGORY_ORDER = POLICY_CATEGORIES;

// Loads employees for the assignment dropdown (id + name only).
function loadEmployeeOptions() {
  return mdb.INTERNAL.employee.find({}, 'name').sort({ name: 1 }).lean();
}

// Default days before the effective review date that a policy is flagged "due
// soon" — used when a policy has no per-policy reviewWarningDays of its own.
const DEFAULT_REVIEW_WARNING_DAYS = 30;

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

// Sanitises a non-negative integer form input, falling back to a default.
function parseNonNegInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// An explicit review date wins; otherwise derive one from the cadence rule
// (now + interval). A 0-month interval with no explicit date means no expiry.
function deriveReviewDate(rawDate, intervalMonths) {
  if (rawDate) return new Date(rawDate);
  if (intervalMonths > 0) return addMonths(new Date(), intervalMonths);
  return null;
}

// Resolves a policy's effective next-review date and review state from its rule.
// effective = explicit reviewDate, else (last update + reviewIntervalMonths).
function resolveReview(policy, now) {
  const interval = Number.isFinite(policy.reviewIntervalMonths) ? policy.reviewIntervalMonths : 12;
  let effective = policy.reviewDate ? new Date(policy.reviewDate) : null;
  if (!effective && interval > 0 && policy.updatedAt) {
    effective = addMonths(new Date(policy.updatedAt), interval);
  }
  if (!effective) return { state: 'none', effective: null };
  const warnDays = Number.isFinite(policy.reviewWarningDays) ? policy.reviewWarningDays : DEFAULT_REVIEW_WARNING_DAYS;
  const warn = new Date(now);
  warn.setDate(warn.getDate() + warnDays);
  if (effective < now) return { state: 'expired', effective };
  if (effective <= warn) return { state: 'due', effective };
  return { state: 'current', effective };
}

function buildGroups(defs, items) {
  return defs
    .map((d) => ({ label: d.label, tone: d.tone || 'default', policies: items.filter(d.match) }))
    .filter((g) => g.policies.length > 0);
}

exports.getPolicyList = async (req, res, next) => {
  try {
    const policies = await mdb.INTERNAL.policyDocument
      .find()
      .populate('employee', 'name')
      .sort({ title: 1 })
      .lean();

    // Annotate each policy with its resolved review state for display + grouping.
    const now = new Date();
    for (const p of policies) {
      const r = resolveReview(p, now);
      p.reviewState = r.state;
      p.effectiveReviewDate = r.effective ? r.effective.toISOString().split('T')[0] : null;
    }

    const groupBy = ['category', 'status', 'review', 'employee'].includes(req.query.groupBy)
      ? req.query.groupBy
      : 'category';

    let groups;
    if (groupBy === 'employee') {
      // Company-wide policies first, then one group per assigned employee (A–Z).
      const companyWide = policies.filter((p) => !p.employee);
      const assigned = policies.filter((p) => p.employee);
      const byEmployee = new Map();
      for (const p of assigned) {
        const name = p.employee.name || 'Unknown employee';
        if (!byEmployee.has(name)) byEmployee.set(name, []);
        byEmployee.get(name).push(p);
      }
      groups = [];
      if (companyWide.length) groups.push({ label: 'Company-wide', tone: 'default', policies: companyWide });
      [...byEmployee.keys()].sort((a, b) => a.localeCompare(b)).forEach((name) => {
        groups.push({ label: name, tone: 'default', policies: byEmployee.get(name) });
      });
    } else if (groupBy === 'status') {
      groups = buildGroups([
        { label: 'Published', tone: 'success', match: (p) => p.isPublished },
        { label: 'Draft',     tone: 'default', match: (p) => !p.isPublished },
      ], policies);
    } else if (groupBy === 'review') {
      groups = buildGroups([
        { label: 'Out of date',   tone: 'danger',  match: (p) => p.reviewState === 'expired' },
        { label: 'Due soon',      tone: 'warning', match: (p) => p.reviewState === 'due' },
        { label: 'Up to date',    tone: 'success', match: (p) => p.reviewState === 'current' },
        { label: 'No review date', tone: 'default', match: (p) => p.reviewState === 'none' },
      ], policies);
    } else {
      // Group by category so the list scales as policies grow.
      const byCategory = new Map();
      for (const p of policies) {
        const cat = p.category || 'General';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(p);
      }
      const rank = (c) => {
        const i = POLICY_CATEGORY_ORDER.indexOf(c);
        return i === -1 ? POLICY_CATEGORY_ORDER.length : i;
      };
      groups = [...byCategory.keys()]
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        .map((category) => ({ label: category, tone: 'default', policies: byCategory.get(category) }));
    }

    res.render('tailwindcss/company-docs/policy-list', {
      title: 'Policies',
      policies,
      groups,
      groupBy,
      groupOptions: [
        { value: 'category', label: 'Category' },
        { value: 'employee', label: 'Employee' },
        { value: 'status',   label: 'Published' },
        { value: 'review',   label: 'Review status' },
      ],
    });
  } catch (err) {
    next(err);
  }
};

// ── Create policy ────────────────────────────────────────────────────────────
exports.getCreatePolicy = async (_req, res, next) => {
  try {
    const employees = await loadEmployeeOptions();
    res.render('tailwindcss/company-docs/policy-form', {
      title: 'New Policy',
      policy: null,
      categories: POLICY_CATEGORIES,
      employees,
      quillEditor: true,
    });
  } catch (err) {
    next(err);
  }
};

exports.postCreatePolicy = async (req, res, next) => {
  try {
    const safeHtml = req.body.contentHtml || '';
    const reviewIntervalMonths = parseNonNegInt(req.body.reviewIntervalMonths, 12);
    const reviewWarningDays = parseNonNegInt(req.body.reviewWarningDays, 30);
    await mdb.INTERNAL.policyDocument.create({
      title:       req.body.title,
      category:    req.body.category,
      employee:    req.body.employee || null,
      version:     req.body.version || '1.0',
      contentHtml: safeHtml,
      isPublished: req.body.isPublished === 'on',
      reviewIntervalMonths,
      reviewWarningDays,
      reviewDate:  deriveReviewDate(req.body.reviewDate, reviewIntervalMonths),
      createdBy:   req.session.user.id,
      updatedBy:   req.session.user.id,
    });
    req.session.successMessage = 'Policy created.';
    res.redirect('/company-docs/policies');
  } catch (err) {
    next(err);
  }
};

// ── Edit policy ──────────────────────────────────────────────────────────────
exports.getEditPolicy = async (req, res, next) => {
  try {
    const [policy, employees] = await Promise.all([
      mdb.INTERNAL.policyDocument.findOne({ uuid: req.params.uuid }).lean(),
      loadEmployeeOptions(),
    ]);
    if (!policy) return next(Object.assign(new Error('Policy not found'), { statusCode: 404 }));
    res.render('tailwindcss/company-docs/policy-form', {
      title: `Edit: ${policy.title}`,
      policy,
      categories: POLICY_CATEGORIES,
      employees,
      quillEditor: true,
    });
  } catch (err) {
    next(err);
  }
};

exports.postEditPolicy = async (req, res, next) => {
  try {
    const policy = await mdb.INTERNAL.policyDocument.findOne({ uuid: req.params.uuid });
    if (!policy) return next(Object.assign(new Error('Policy not found'), { statusCode: 404 }));
    const safeHtml = req.body.contentHtml || '';
    const reviewIntervalMonths = parseNonNegInt(req.body.reviewIntervalMonths, 12);
    policy.title                = req.body.title;
    policy.category             = req.body.category;
    policy.employee             = req.body.employee || null;
    policy.version              = req.body.version || policy.version;
    policy.contentHtml          = safeHtml;
    policy.isPublished          = req.body.isPublished === 'on';
    policy.reviewIntervalMonths = reviewIntervalMonths;
    policy.reviewWarningDays    = parseNonNegInt(req.body.reviewWarningDays, 30);
    policy.reviewDate           = deriveReviewDate(req.body.reviewDate, reviewIntervalMonths);
    policy.updatedBy            = req.session.user.id;
    await policy.save();
    req.session.successMessage = 'Policy updated.';
    res.redirect('/company-docs/policies');
  } catch (err) {
    next(err);
  }
};

// ── Delete policy ────────────────────────────────────────────────────────────
exports.postDeletePolicy = async (req, res, next) => {
  try {
    await mdb.INTERNAL.policyDocument.deleteOne({ uuid: req.params.uuid });
    req.session.successMessage = 'Policy deleted.';
    res.redirect('/company-docs/policies');
  } catch (err) {
    next(err);
  }
};

// ── Print view ───────────────────────────────────────────────────────────────
exports.getPrintPolicy = async (req, res, next) => {
  try {
    const [policy, letterhead] = await Promise.all([
      mdb.INTERNAL.policyDocument.findOne({ uuid: req.params.uuid }).populate('employee', 'name position').lean(),
      mdb.INTERNAL.letterhead.findOne().select('-logoData').lean(),
    ]);
    if (!policy) return next(Object.assign(new Error('Policy not found'), { statusCode: 404 }));
    res.render('tailwindcss/company-docs/policy-print', {
      title: policy.title,
      policy,
      letterhead: letterhead || {},
    });
  } catch (err) {
    next(err);
  }
};
