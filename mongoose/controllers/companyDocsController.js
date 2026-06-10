'use strict';

const path = require('path');
const multer = require('multer');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const csrfService = require('../../services/csrfService');

// contentHtml is pre-sanitised by the global xssSanitize middleware
// (securityService.js) with the richTextXssOptions whitelist.
// No additional filterXSS call is needed here.

// ── Logo upload storage ──────────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '../../public/images');
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `letterhead-logo${ext}`);
  },
});

const logoUpload = multer({
  storage: logoStorage,
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
      mdb.INTERNAL.letterhead.findOne().lean(),
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
    const letterhead = await mdb.INTERNAL.letterhead.findOne().lean();
    res.render('tailwindcss/company-docs/letterhead', {
      title: 'Letterhead Settings',
      letterhead: letterhead || {},
    });
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
        update.logoPath = `/resources/images/${req.file.filename}`;
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
exports.getPolicyList = async (req, res, next) => {
  try {
    const policies = await mdb.INTERNAL.policyDocument
      .find()
      .sort({ category: 1, title: 1 })
      .lean();
    res.render('tailwindcss/company-docs/policy-list', {
      title: 'Policies',
      policies,
    });
  } catch (err) {
    next(err);
  }
};

// ── Create policy ────────────────────────────────────────────────────────────
exports.getCreatePolicy = (_req, res) => {
  res.render('tailwindcss/company-docs/policy-form', {
    title: 'New Policy',
    policy: null,
    quillEditor: true,
  });
};

exports.postCreatePolicy = async (req, res, next) => {
  try {
    const safeHtml = req.body.contentHtml || '';
    await mdb.INTERNAL.policyDocument.create({
      title:       req.body.title,
      category:    req.body.category,
      version:     req.body.version || '1.0',
      contentHtml: safeHtml,
      isPublished: req.body.isPublished === 'on',
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
    const policy = await mdb.INTERNAL.policyDocument.findOne({ uuid: req.params.uuid }).lean();
    if (!policy) return next(Object.assign(new Error('Policy not found'), { statusCode: 404 }));
    res.render('tailwindcss/company-docs/policy-form', {
      title: `Edit: ${policy.title}`,
      policy,
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
    policy.title       = req.body.title;
    policy.category    = req.body.category;
    policy.version     = req.body.version || policy.version;
    policy.contentHtml = safeHtml;
    policy.isPublished = req.body.isPublished === 'on';
    policy.updatedBy   = req.session.user.id;
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
      mdb.INTERNAL.policyDocument.findOne({ uuid: req.params.uuid }).lean(),
      mdb.INTERNAL.letterhead.findOne().lean(),
    ]);
    if (!policy) return next(Object.assign(new Error('Policy not found'), { statusCode: 404 }));
    res.render('tailwindcss/company-docs/policy-print', {
      layout: false,
      title: policy.title,
      policy,
      letterhead: letterhead || {},
    });
  } catch (err) {
    next(err);
  }
};
