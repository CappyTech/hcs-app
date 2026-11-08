/**
 * Separation of duties (docs/PERMISSION-GROUPS.md, decision 3).
 *
 * Decided: a job role given a `manage` level (Director) still needs a second
 * person. Whoever took the step before can't take the step that sends the
 * item out of the app:
 *
 *   entered an invoice (Documents data entry)  → can't send it to KashFlow
 *   entered a purchase                         → can't pay it (bulk payments)
 *   confirmed bank matches in a period         → can't sign that period off
 *   locked a payroll run                       → can't submit its FPS or
 *                                                pension, or post its journal
 *
 * The legacy `admin` (System Administrator) and `accountant` (Bookkeeper)
 * roles are exempt: they did all of this alone before job roles existed, and
 * admin stays the one-person cover, as with attendance approval.
 */
export const EXEMPT_ROLES = ['admin', 'accountant'];

const idOf = (v) => {
  if (!v) return null;
  if (typeof v === 'object') {
    if (v.userId) return String(v.userId); // PAPERLESS ActorSchema
    if (v._id) return String(v._id);
  }
  return String(v);
};

/** Does the rule apply to this user? */
export function applies(user) {
  return !!user && !EXEMPT_ROLES.includes(user.role);
}

/** True when `actor` (an id, a user, or a { userId } stamp) is `user`. */
export function isSamePerson(user, actor) {
  const a = idOf(actor);
  return !!a && !!user?._id && a === String(user._id);
}

/** Should this user be stopped, given who took the step before? */
export function blocks(user, actor) {
  return applies(user) && isSamePerson(user, actor);
}

export const MESSAGES = {
  sendInvoice: 'You entered this invoice, so someone else sends it to KashFlow.',
  payPurchases: (n) => `You entered ${n} of these invoice${n === 1 ? '' : 's'}, so someone else pays ${n === 1 ? 'it' : 'them'}. Leave ${n === 1 ? 'it' : 'them'} out, or ask someone else.`,
  signOff: 'You confirmed matches in this period, so someone else signs it off.',
  payrollRun: 'You locked this payroll run, so someone else submits it.',
};

export default { EXEMPT_ROLES, applies, isSamePerson, blocks, MESSAGES };
