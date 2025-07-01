const mdb = require('../services/mongooseDatabaseService');

exports.changeReceipts = async (req, res, next) => {
  try {
    const { submissionDate, uuids, redirectPath } = req.body;
    const targetUUIDs = uuids && uuids.length ? (Array.isArray(uuids) ? uuids : [uuids]) : [];

    if (targetUUIDs.length === 0) {
      req.flash('error', 'No receipts selected.');
      return res.redirect(redirectPath || '/mdb/CIS');
    }

    await mdb.receipt.updateMany(
      { uuid: { $in: targetUUIDs } },
      { $set: { SubmissionDate: submissionDate ? new Date(submissionDate) : null } }
    );

    res.redirect(redirectPath || '/CIS');
  } catch (error) {
    next(error);
  }
};

