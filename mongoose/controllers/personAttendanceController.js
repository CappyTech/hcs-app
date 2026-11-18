import path from 'path';
import svc from '../services/personAttendanceService.js';

/**
 * Attendance by person: one employee's or subcontractor's days across weeks.
 * The guard on the routes lets in whoever reads /daily; personAttendanceService
 * then scopes every query to what the viewer may see.
 */

// Keep the range in links between the picker and a person
function rangeQuery(range) {
  if (range.preset) return `?preset=${encodeURIComponent(range.preset)}`;
  return `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

/** GET /attendance/person — pick a person. An employee or subcontractor goes straight to their own page. */
export const getPeople = async (req, res, next) => {
  try {
    const range = svc.rangeFrom(req.query);
    if (['employee', 'subcontractor'].includes(req.user?.role)) {
      const own = await svc.ownPersonPath(req.user);
      if (own) return res.redirect(`${own}${rangeQuery(range)}`);
    }
    const people = await svc.peopleInRange(req, range);
    if (people === null) {
      req.flash('error', "You don't have access to attendance.");
      return res.redirect('/');
    }
    res.render(path.join('tailwindcss', 'attendance', 'personIndex'), {
      title: 'Attendance by person',
      people,
      range,
      rangeQuery: rangeQuery(range),
    });
  } catch (err) {
    next(err);
  }
};

/** GET /attendance/person/:kind/:uuid — one person's days, grouped by week. */
export const getPerson = async (req, res, next) => {
  try {
    const range = svc.rangeFrom(req.query);
    const result = await svc.personHistory(req, req.params.kind, req.params.uuid, range);
    if (result.notFound) {
      req.flash('error', 'Person not found.');
      return res.redirect('/attendance/person');
    }
    if (result.denied) {
      req.flash('error', "You don't have access to attendance.");
      return res.redirect('/');
    }
    res.render(path.join('tailwindcss', 'attendance', 'person'), {
      title: `Attendance: ${result.person.name || result.label}`,
      ...result,
      range,
      rangeQuery: rangeQuery(range),
      basePath: `/attendance/person/${req.params.kind}/${encodeURIComponent(result.person.uuid)}`,
      typeLabels: svc.TYPE_LABELS,
      statusLabels: svc.STATUS_LABELS,
      // Only those who pick people get a way back to the list
      canPick: !['employee', 'subcontractor'].includes(req.user?.role),
    });
  } catch (err) {
    next(err);
  }
};

export default { getPeople, getPerson };
