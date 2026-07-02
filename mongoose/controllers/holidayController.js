const path = require("path");
const logger = require("../../services/loggerService");
const holidayService = require("../services/holidayService");
const mdb = require("../services/mongooseDatabaseService");

async function checkHoliday(req, res, next) {
  const skipPaths = ["/", "/user/login", "/user/register"];
  if (!res.locals.isAuthenticated) {
    return next();
  }
  if (skipPaths.includes(req.path)) {
    return next();
  }

  try {
    const holidayDetails = await holidayService.isDateHoliday();
    if (holidayDetails?.isHoliday) {
      const dismissed = await mdb.INTERNAL.holidayDismissal.findOne({
        userId: req.user._id,
        holidayId: holidayDetails._id,
      });

      if (!dismissed) {
        logger.info(
          `Holiday: ${holidayDetails.reason} (${holidayDetails.startDate} to ${holidayDetails.endDate})`,
        );
        return res.render(path.join("tailwindcss", "holiday"), {
          title: "Holiday Notice",
          reason: holidayDetails.reason,
          startDate: holidayDetails.startDate,
          endDate: holidayDetails.endDate,
        });
      }
      return next();
    }
    return next();
  } catch (err) {
    logger.error("Holiday check error: " + err.message);
    return next(err);
  }
}

// POST handler for dismissing holiday for current user
async function dismissHoliday(req, res, next) {
  try {
    const holidayDetails = await holidayService.isDateHoliday();
    if (!holidayDetails?.isHoliday) {
      return next();
    }

    await mdb.INTERNAL.holidayDismissal.updateOne(
      {
        userId: req.user._id,
        holidayId: holidayDetails._id,
      },
      {
        $setOnInsert: { dismissedAt: new Date() },
      },
      { upsert: true },
    );

    logger.info(
      `Holiday Dismissed. ${holidayDetails.reason} | ${req.user?.username}`,
    );
    req.flash("success", "Holiday notification dismissed.");
    return res.redirect("/");
  } catch (err) {
    logger.error("Error dismissing holiday: " + err.message);
    return next(err);
  }
}

module.exports = {
  checkHoliday,
  dismissHoliday,
};
