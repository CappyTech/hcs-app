import mdb from '../services/mongooseDatabaseService.js';

export const changeReceipts = async (req, res, next) => {
  try {
    const { submissionDate, uuids, redirectPath } = req.body;
    const targetUUIDs =
      uuids && uuids.length ? (Array.isArray(uuids) ? uuids : [uuids]) : [];

    if (targetUUIDs.length === 0) {
      req.flash("error", "No receipts selected.");
      return res.redirect(redirectPath || "/mdb/CIS");
    }

    await mdb.REST.purchase.updateMany(
      { uuid: { $in: targetUUIDs } },
      {
        $set: {
          SubmissionDate: submissionDate ? new Date(submissionDate) : null,
        },
      },
    );

    res.redirect(redirectPath || "/CIS");
  } catch (error) {
    next(error);
  }
};

/**
 * Update SubmissionDate for one or more REST purchases by uuid.
 * Expects body: { submissionDate: 'YYYY-MM-DD', uuids: string|string[], redirectPath?: string }
 */
export const changePurchases = async (req, res, next) => {
  try {
    const { submissionDate, uuids, redirectPath } = req.body;
    const targetUUIDs =
      uuids && uuids.length ? (Array.isArray(uuids) ? uuids : [uuids]) : [];

    if (targetUUIDs.length === 0) {
      req.flash("error", "No purchases selected.");
      return res.redirect(redirectPath || "/CIS/Dashboard/");
    }

    await mdb.REST.purchase.updateMany(
      { uuid: { $in: targetUUIDs } },
      {
        $set: {
          SubmissionDate: submissionDate ? new Date(submissionDate) : null,
        },
      },
    );

    req.flash("success", `Updated ${targetUUIDs.length} purchase(s).`);
    res.redirect(redirectPath || "/CIS");
  } catch (error) {
    next(error);
  }
};

export default { changeReceipts, changePurchases };
