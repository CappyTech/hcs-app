import mdb from '../services/mongooseDatabaseService.js';
import logger from '../../services/loggerService.js';

// Human-readable labels for each UK GDPR right
const TYPE_LABELS = {
  access:        'Subject Access Request (Art. 15)',
  rectification: 'Rectification (Art. 16)',
  erasure:       'Erasure — Right to be Forgotten (Art. 17)',
  restriction:   'Restriction of Processing (Art. 18)',
  portability:   'Data Portability (Art. 20)',
  objection:     'Objection to Processing (Art. 21)',
};

// Tailwind badge classes per status — follows UI-GUIDELINES §10 badge spec
const STATUS_CLASSES = {
  pending:      'bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700',
  under_review: 'bg-blue-100 text-blue-800 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700',
  approved:     'bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
  rejected:     'bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
  completed:    'bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
  withdrawn:    'bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700',
};

// ── User-facing handlers ──────────────────────────────────────────────

/**
 * GET /gdpr/requests
 * List the authenticated user's own GDPR requests.
 */
async function listMyRequests(req, res, next) {
  try {
    const GdprRequest = mdb.INTERNAL.gdprRequest;
    const requests = await GdprRequest
      .find({ requestedBy: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.render('tailwindcss/gdpr/index', {
      title: 'My GDPR Requests',
      requests,
      TYPE_LABELS,
      STATUS_CLASSES,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /gdpr/requests/new
 * Render the request submission form.
 */
function newRequestForm(req, res) {
  res.render('tailwindcss/gdpr/new', {
    title: 'Submit a GDPR Request',
    TYPE_LABELS,
    error: null,
  });
}

/**
 * POST /gdpr/requests
 * Create a new GDPR request. requestedBy is always set to the current user.
 */
async function submitRequest(req, res, next) {
  try {
    const { type, description } = req.body;
    const GdprRequest = mdb.INTERNAL.gdprRequest;

    if (!type || !Object.keys(TYPE_LABELS).includes(type)) {
      return res.status(400).render('tailwindcss/gdpr/new', {
        title: 'Submit a GDPR Request',
        TYPE_LABELS,
        error: 'Please select a valid request type.',
      });
    }

    const request = new GdprRequest({
      requestedBy: req.user._id,
      type,
      description: (description || '').slice(0, 2000),
    });

    request.evidenceLog.push({
      action:  'submitted',
      actorId: req.user._id,
      notes:   'Request submitted by data subject.',
    });

    await request.save();
    logger.info(`[gdpr] Request submitted uuid=${request.uuid} type=${type} user=${req.user._id}`);

    res.redirect(`/gdpr/requests/${request.uuid}`);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /gdpr/requests/:uuid
 * View a single request. Users may only view their own; admins may view any.
 */
async function getRequest(req, res, next) {
  try {
    const GdprRequest = mdb.INTERNAL.gdprRequest;
    const request = await GdprRequest.findOne({ uuid: req.params.uuid }).lean();

    if (!request) {
      const err = new Error('GDPR request not found.');
      err.statusCode = 404;
      return next(err);
    }

    // Non-admin users may only see their own requests
    if (req.user.role !== 'admin' && String(request.requestedBy) !== String(req.user._id)) {
      const err = new Error('You do not have permission to view this request.');
      err.statusCode = 403;
      return next(err);
    }

    const isAdmin = req.user.role === 'admin';
    // An admin who is also the requester may view but not review
    const canReview = isAdmin && String(request.requestedBy) !== String(req.user._id);

    res.render('tailwindcss/gdpr/show', {
      title: 'GDPR Request',
      request,
      TYPE_LABELS,
      STATUS_CLASSES,
      isAdmin,
      canReview,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /gdpr/requests/:uuid/withdraw
 * Data subject withdraws their own pending request.
 */
async function withdrawRequest(req, res, next) {
  try {
    const GdprRequest = mdb.INTERNAL.gdprRequest;
    const request = await GdprRequest.findOne({ uuid: req.params.uuid });

    if (!request) {
      const err = new Error('GDPR request not found.');
      err.statusCode = 404;
      return next(err);
    }

    if (String(request.requestedBy) !== String(req.user._id)) {
      const err = new Error('You may only withdraw your own requests.');
      err.statusCode = 403;
      return next(err);
    }

    if (request.status !== 'pending') {
      const err = new Error('Only pending requests can be withdrawn.');
      err.statusCode = 400;
      return next(err);
    }

    request.status = 'withdrawn';
    request.evidenceLog.push({
      action:  'withdrawn',
      actorId: req.user._id,
      notes:   'Withdrawn by data subject.',
    });

    await request.save();
    logger.info(`[gdpr] Request withdrawn uuid=${request.uuid} user=${req.user._id}`);

    res.redirect(`/gdpr/requests/${request.uuid}`);
  } catch (err) {
    next(err);
  }
}

// ── Admin-only handlers ───────────────────────────────────────────────

/**
 * GET /admin/gdpr/requests
 * Admin list of all GDPR requests with requester identity resolved.
 */
async function adminListRequests(req, res, next) {
  try {
    const GdprRequest = mdb.INTERNAL.gdprRequest;
    const User = mdb.INTERNAL.user;

    const requests = await GdprRequest.find({}).sort({ createdAt: -1 }).lean();

    // Resolve requester usernames in one query
    const userIds = [...new Set(requests.map(r => String(r.requestedBy)))];
    const users = await User
      .find({ _id: { $in: userIds } })
      .select('_id username email')
      .lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    const enriched = requests.map(r => ({
      ...r,
      requesterLabel: userMap[String(r.requestedBy)]?.username || 'Unknown',
    }));

    res.render('tailwindcss/gdpr/admin', {
      title: 'GDPR Requests — Admin',
      requests: enriched,
      TYPE_LABELS,
      STATUS_CLASSES,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/gdpr/requests/:uuid/review
 * Admin updates status and/or adminNotes on a request.
 * A user may never review their own request — enforced here and in the model.
 */
async function adminReviewRequest(req, res, next) {
  try {
    const GdprRequest = mdb.INTERNAL.gdprRequest;
    const request = await GdprRequest.findOne({ uuid: req.params.uuid });

    if (!request) {
      const err = new Error('GDPR request not found.');
      err.statusCode = 404;
      return next(err);
    }

    // Separation-of-duties guard (also enforced by model pre-save hook)
    if (String(request.requestedBy) === String(req.user._id)) {
      const err = new Error('You may not review your own GDPR request.');
      err.statusCode = 403;
      return next(err);
    }

    const ALLOWED_STATUSES = ['under_review', 'approved', 'rejected', 'completed'];
    const { status, adminNotes } = req.body;

    if (!ALLOWED_STATUSES.includes(status)) {
      const err = new Error('Invalid status value.');
      err.statusCode = 400;
      return next(err);
    }

    request.status     = status;
    request.adminNotes = adminNotes ? String(adminNotes).slice(0, 2000) : request.adminNotes;
    request.reviewedBy  = req.user._id;
    request.reviewedAt  = new Date();
    if (status === 'completed') request.completedAt = new Date();

    request.evidenceLog.push({
      action:  `status_set_to_${status}`,
      actorId: req.user._id,
      notes:   adminNotes ? 'Admin notes updated.' : undefined,
    });

    await request.save();
    logger.info(`[gdpr] Request reviewed uuid=${request.uuid} status=${status} by=${req.user._id}`);

    res.redirect(`/gdpr/requests/${request.uuid}`);
  } catch (err) {
    next(err);
  }
}

export default {
  listMyRequests,
  newRequestForm,
  submitRequest,
  getRequest,
  withdrawRequest,
  adminListRequests,
  adminReviewRequest,
};

export { listMyRequests, newRequestForm, submitRequest, getRequest, withdrawRequest, adminListRequests, adminReviewRequest };
