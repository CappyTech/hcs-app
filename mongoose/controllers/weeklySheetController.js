import path from 'path';
import { formatInTimeZone } from 'date-fns-tz';
import logger from '../../services/loggerService.js';
import mdb from '../services/mongooseDatabaseService.js';
import weeklySheet from '../services/weeklySheetService.js';
import { listSubcontractors } from '../services/weeklyFlowService.js';
import overviewEngine from '../services/overviewEngine.js';

const GROUP_KEYS = new Set(weeklySheet.GROUPS.map((g) => g.key));
const readGroup = (v) => (GROUP_KEYS.has(String(v || '')) ? String(v) : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const backTo = (monday, group) => `/weekly-sheet/${monday}${group ? `?group=${group}` : ''}`;

/** People who can be added to the week: employees (active first) and CIS subcontractors not on it yet. */
async function addChoices(rows) {
  const shown = new Set(rows.map((r) => r.key));
  const [employees, subcontractors] = await Promise.all([
    mdb.INTERNAL.employee.find({}).select('_id name status').sort({ name: 1 }).lean(),
    listSubcontractors(),
  ]);
  return {
    employees: employees.filter((e) => !shown.has(`e:${e._id}`)).map((e) => ({ value: `e:${e._id}`, label: e.name, inactive: e.status === 'inactive' })),
    subcontractors: subcontractors.filter((s) => !shown.has(`s:${s._id}`)).map((s) => ({ value: `s:${s._id}`, label: s.Name })),
  };
}

const dayLabelsOf = (days) => days.map((d) => formatInTimeZone(new Date(`${d}T12:00:00Z`), 'Europe/London', 'EEE d/M'));

async function renderSheet(req, res, { data, group, notice = null }) {
  const allRows = data.sheet.allRows || data.sheet.sections.flatMap((s) => s.rows);
  res.render(path.join('tailwindcss', 'attendance', 'weekly-sheet'), {
    title: 'Weekly attendance sheet',
    ...data,
    group,
    groups: weeklySheet.GROUPS,
    addChoices: await addChoices(allRows),
    dayLabels: dayLabelsOf(data.week.days),
    notice,
    crumbs: overviewEngine.breadcrumbs(req, 'weekly'),
  });
}

/** GET /weekly-sheet/:monday? */
export const getSheet = async (req, res, next) => {
  try {
    const group = readGroup(req.query.group);
    const data = await weeklySheet.loadSheet(req.params.monday, { isAdmin: req.user?.role === 'admin', group });
    await renderSheet(req, res, { data, group });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /weekly-sheet/:monday/copy-day — a "copy from yesterday" button on one
 * person's day (copy = "<personKey>|<yyyy-mm-dd>"). Shows the sheet again as
 * it was in the form, with that day filled in from the day before. Nothing
 * is saved until Save week.
 */
export const postCopyDay = async (req, res, next) => {
  try {
    const group = readGroup(req.body.group);
    const [person, day] = String(req.body.copy || '').split('|');
    const data = await weeklySheet.loadSheet(req.params.monday, { isAdmin: req.user?.role === 'admin', group });
    const rows = data.sheet.allRows || data.sheet.sections.flatMap((s) => s.rows);
    const { draft, copied, from } = weeklySheet.copyFromYesterday({
      rows, days: data.week.days, person, day, cells: req.body.cell, allowed: new Set(data.sheet.choices.map((c) => c.value)),
    });
    for (const row of rows) for (const cell of row.cells) if (cell.editable && draft[row.key]) cell.draft = draft[row.key][cell.day];
    const name = rows.find((r) => r.key === person)?.name || 'them';
    const label = (d) => dayLabelsOf([d])[0];
    const notice = !from ? null : copied
      ? `Copied ${name}'s ${label(from)} into ${label(day)}. Not saved yet: press Save week to keep it.`
      : `Nothing to copy: ${name} has nothing on ${label(from)}, or it can't go on ${label(day)}.`;
    await renderSheet(req, res, { data, group, notice });
  } catch (err) {
    next(err);
  }
};

/** POST /weekly-sheet/:monday */
export const postSheet = async (req, res, next) => {
  const group = readGroup(req.body.group);
  const monday = weeklySheet.resolveWeek(req.params.monday).monday;
  try {
    const { saved, skipped } = await weeklySheet.saveSheet(req.params.monday, req.body, { isAdmin: req.user?.role === 'admin', actorId: req.user?._id });
    logger.info(`[weeklySheetController] Week ${monday}: saved ${saved}, skipped ${skipped}`);
    if (saved) req.flash('success', `Saved ${plural(saved, 'day')}. New days are planned until confirmed on the day.`);
    if (skipped) req.flash('error', `${plural(skipped, 'day')} not saved: changed by someone else since you opened the page, signed off, or in a locked payroll period. Reload to see them.`);
    if (!saved && !skipped) req.flash('success', 'Nothing had changed.');
    res.redirect(backTo(monday, group));
  } catch (err) {
    next(err);
  }
};

/** POST /weekly-sheet/:monday/people/add — add someone to this week and the weeks after. */
export const postAddPerson = async (req, res, next) => {
  const group = readGroup(req.body.group);
  const monday = weeklySheet.resolveWeek(req.params.monday).monday;
  try {
    await weeklySheet.changePeople(monday, req.body.person, 'add', req.user?._id);
    req.flash('success', 'Added to this week and the weeks after it.');
    res.redirect(backTo(monday, group));
  } catch (err) {
    if (err.status === 400) { req.flash('error', err.message); return res.redirect(backTo(monday, group)); }
    next(err);
  }
};

/**
 * POST /weekly-sheet/:monday/people/remove — the Remove button on a row.
 * It's part of the week's form, so any days changed on the sheet are saved
 * first; then the person comes off this week and the weeks after (anyone with
 * attendance in a week still shows that week).
 */
export const postRemovePerson = async (req, res, next) => {
  const group = readGroup(req.body.group);
  const monday = weeklySheet.resolveWeek(req.params.monday).monday;
  try {
    const { saved } = await weeklySheet.saveSheet(monday, req.body, { isAdmin: req.user?.role === 'admin', actorId: req.user?._id });
    await weeklySheet.changePeople(monday, req.body.removePerson, 'remove', req.user?._id);
    req.flash('success', `Removed from this week and the weeks after it.${saved ? ` Saved ${plural(saved, 'day')} first.` : ''} Anyone with days recorded still shows in those weeks.`);
    res.redirect(backTo(monday, group));
  } catch (err) {
    if (err.status === 400) { req.flash('error', err.message); return res.redirect(backTo(monday, group)); }
    next(err);
  }
};

export default { getSheet, postSheet, postCopyDay, postAddPerson, postRemovePerson };
