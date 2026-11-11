import path from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import logger from '../../services/loggerService.js';
import weeklySheet from '../services/weeklySheetService.js';
import { listSubcontractors } from '../services/weeklyFlowService.js';
import overviewEngine from '../services/overviewEngine.js';

const GROUP_KEYS = new Set(weeklySheet.GROUPS.map((g) => g.key));
const readGroup = (v) => (GROUP_KEYS.has(String(v || '')) ? String(v) : '');
const readOid = (v) => (/^[0-9a-f]{24}$/.test(String(v || '')) ? String(v) : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** GET /weekly-sheet/:monday? */
export const getSheet = async (req, res, next) => {
  try {
    const group = readGroup(req.query.group);
    const addSubcontractor = readOid(req.query.add);
    const isAdmin = req.user?.role === 'admin';
    const [data, subcontractorChoices] = await Promise.all([
      weeklySheet.loadSheet(req.params.monday, { isAdmin, group, addSubcontractor }),
      listSubcontractors(),
    ]);
    const shownSubs = new Set(data.sheet.sections.flatMap((s) => s.rows).filter((r) => r.kind === 'subcontractor').map((r) => r.mongoId));
    res.render(path.join('tailwindcss', 'attendance', 'weekly-sheet'), {
      title: 'Weekly attendance sheet',
      ...data,
      group,
      groups: weeklySheet.GROUPS,
      addSubcontractor,
      subcontractorChoices: subcontractorChoices.filter((s) => !shownSubs.has(String(s._id))),
      dayLabels: data.week.days.map((d) => formatInTimeZone(new Date(`${d}T12:00:00Z`), 'Europe/London', 'EEE d/M')),
      crumbs: overviewEngine.breadcrumbs(req, 'weekly'),
    });
  } catch (err) {
    next(err);
  }
};

/** POST /weekly-sheet/:monday */
export const postSheet = async (req, res, next) => {
  const group = readGroup(req.body.group);
  const monday = weeklySheet.resolveWeek(req.params.monday).monday;
  const back = `/weekly-sheet/${monday}${group ? `?group=${group}` : ''}`;
  try {
    const { saved, skipped } = await weeklySheet.saveSheet(req.params.monday, req.body, { isAdmin: req.user?.role === 'admin' });
    logger.info(`[weeklySheetController] Week ${monday}: saved ${saved}, skipped ${skipped}`);
    if (saved) req.flash('success', `Saved ${plural(saved, 'day')}. New days are pending approval.`);
    if (skipped) req.flash('error', `${plural(skipped, 'day')} not saved: changed by someone else since you opened the page, signed off, or in a locked payroll period. Reload to see them.`);
    if (!saved && !skipped) req.flash('success', 'Nothing had changed.');
    res.redirect(back);
  } catch (err) {
    next(err);
  }
};

export default { getSheet, postSheet };
