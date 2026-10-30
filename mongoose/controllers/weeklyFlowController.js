import path from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import logger from '../../services/loggerService.js';
import weeklyFlowService from '../services/weeklyFlowService.js';
import overviewEngine from '../services/overviewEngine.js';

const params = (req) => [parseInt(req.params.year), parseInt(req.params.week)];
const back = (req, anchor) => `/weekly-flow/${parseInt(req.params.year)}/${parseInt(req.params.week)}${anchor ? `#${anchor}` : ''}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** GET /weekly-flow/:year?/:week? */
export const getWeekFlow = async (req, res, next) => {
  try {
    const { week, flow, lockedRun, employees, subcontractors } = await weeklyFlowService.loadWeek(...params(req));
    res.render(path.join('tailwindcss', 'attendance', 'week-flow'), {
      title: `Weekly attendance — Tax Week ${week.week}`,
      week,
      flow,
      lockedRun,
      employees,
      subcontractors,
      dayLabels: week.days.map((d) => formatInTimeZone(new Date(`${d}T12:00:00Z`), 'Europe/London', 'EEE d')),
      canApprove: req.user?.role === 'admin',
      personKey: weeklyFlowService.personKey,
      // Home › Projects › Weekly attendance (the overview), following the hierarchy
      crumbs: overviewEngine.breadcrumbs(req, 'weekly'),
    });
  } catch (err) {
    next(err);
  }
};

/** POST /weekly-flow/:year/:week/assignments */
export const postAssignment = async (req, res, next) => {
  try {
    const { contractUuid, title, employees, subcontractors, estimatedHours } = req.body;
    await weeklyFlowService.createAssignment(...params(req), { contractUuid, title, employees, subcontractors, estimatedHours });
    req.flash('success', 'Assignment added.');
    res.redirect(back(req, 'step-2'));
  } catch (err) {
    if (err.status === 400 || err.name === 'ValidationError') {
      req.flash('error', err.status === 400 ? err.message : 'Could not add the assignment.');
      return res.redirect(back(req, 'step-2'));
    }
    next(err);
  }
};

/** POST /weekly-flow/:year/:week/copy-previous */
export const postCopyPrevious = async (req, res, next) => {
  try {
    const copied = await weeklyFlowService.copyPreviousWeek(...params(req));
    req.flash(copied ? 'success' : 'error', copied
      ? `Copied ${plural(copied, 'assignment')} from last week.`
      : 'Nothing to copy: last week had no assignments on contracts still running, or they are already here.');
    res.redirect(back(req, 'step-2'));
  } catch (err) {
    next(err);
  }
};

/** POST /weekly-flow/:year/:week/record */
export const postRecord = async (req, res, next) => {
  try {
    const { assignmentUuid, days, hours } = req.body;
    const { created, skipped } = await weeklyFlowService.recordAttendance(...params(req), {
      assignmentUuid,
      days,
      hours,
      isAdmin: req.user?.role === 'admin',
    });
    logger.info(`[weeklyFlowController] Recorded ${created} attendance rows for assignment ${assignmentUuid}`);
    if (created) req.flash('success', `Recorded ${plural(created, 'day')} as pending.`);
    if (skipped.length) req.flash('error', `${plural(skipped.length, 'day')} skipped: already recorded, or in a locked payroll period.`);
    if (!created && !skipped.length) req.flash('error', 'No days were ticked.');
    res.redirect(back(req, 'step-3'));
  } catch (err) {
    if (err.status === 400) {
      req.flash('error', err.message);
      return res.redirect(back(req, 'step-3'));
    }
    next(err);
  }
};

export default { getWeekFlow, postAssignment, postCopyPrevious, postRecord };
