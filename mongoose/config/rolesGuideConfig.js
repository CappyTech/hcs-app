/**
 * Roles guide — the public /roles article: who each role is and how they use
 * the app day to day.
 *
 * Two kinds of entry:
 *  - `roles`    the account roles (rolePermissionsConfig). Everything about
 *               them is written here.
 *  - `jobRoles` the job roles (accessGroupsConfig.jobRoles). Only the
 *               day-to-day prose lives here; the label, description and the
 *               areas each one opens are read from accessGroupsConfig by
 *               rolesGuideController, so the page cannot drift from the
 *               grants. A job role with no entry here still appears, with
 *               just its derived areas.
 *
 * `benefit` (optional) is a "what's in it for you" line, for the roles held
 * by people who aren't running the business.
 *
 * The page is public (shown signed out), so keep it to how the app is used:
 * no business data, no internal hostnames, nothing an outsider could use.
 * Write about what is live on master, not what a branch is adding.
 */

export const roles = [
  {
    id: 'admin',
    label: 'Admin',
    icon: 'bi-shield-lock',
    audience: 'Staff',
    summary: 'Runs the system. Sees every area, sets up people and their access, and is the one who signs off and sends.',
    uses: [
      { title: 'Sets people up', text: 'Creates accounts, links each one to an employee, subcontractor or customer record, and gives them a role and any job roles. Every change to someone\'s access is written to the security log.' },
      { title: 'Approves the week', text: 'Checks attendance as it comes in, approves or rejects it, and works through the weekly view so payroll and CIS run on approved days only.' },
      { title: 'Sends to KashFlow and HMRC', text: 'Anything that leaves the building — invoices sent to KashFlow, supplier payments, RTI and CIS submissions, pension files — is manage-level work. Admin can do it alone; a Director can too, but never on something they entered, locked or confirmed themselves.' },
      { title: 'Keeps the lights on', text: 'Settings, integrations, background jobs, logs, maintenance mode and the audit trail all live under Admin.' },
    ],
    where: ['Admin', 'Every department dashboard', 'Create', 'Settings'],
    notes: ['Two-factor authentication is required.'],
  },
  {
    id: 'accountant',
    label: 'Accountant',
    icon: 'bi-calculator',
    audience: 'Staff',
    summary: 'Keeps the books. Reads the sales and purchase ledgers, reconciles the bank, pays suppliers and runs payroll.',
    uses: [
      { title: 'Reads the ledgers', text: 'Invoices, purchases, suppliers, customers, projects, quotes and nominals, as synced from the accounting system. They are read-only here; changes are made at source.' },
      { title: 'Reconciles the bank', text: 'Matches bank lines to invoices and purchases, confirms matches and signs off each period.' },
      { title: 'Pays suppliers', text: 'Picks several purchase invoices and pays them in one bulk payment.' },
      { title: 'Runs payroll and CIS', text: 'Reads everyone\'s approved attendance for the period, runs payroll, and checks the monthly CIS dashboard and returns.' },
    ],
    where: ['Finance', 'Payroll', 'CIS', 'Accountant'],
    notes: ['Two-factor authentication is required.'],
  },
  {
    id: 'employee',
    label: 'Employee',
    icon: 'bi-person-workspace',
    audience: 'Staff',
    summary: 'Works for the company directly. Records their own days, books holiday and sees their own details.',
    benefit: 'No paper timesheets or chasing the office: you can see which of your days are approved, what holiday you have left and when your van is due its MOT, any time, on your phone.',
    uses: [
      { title: 'Records each day', text: 'Submits attendance — work, training, sick, holiday, leave or off — with the site or project worked on. Each record waits as Pending until it is approved, by the site first where the site has a manager.' },
      { title: 'Books holiday', text: 'Checks their holiday balance and asks for time off; the request goes to whoever approves holidays.' },
      { title: 'Their van', text: 'Sees any vehicle assigned to them, with its fuel and mileage logs.' },
      { title: 'Their own record', text: 'Sees their own employee profile. Nobody else\'s records are visible.' },
    ],
    where: ['Attendance', 'User'],
  },
  {
    id: 'subcontractor',
    label: 'Subcontractor',
    icon: 'bi-person-gear',
    audience: 'External',
    summary: 'Works for the company under CIS. Records their days and checks what they have been paid and what was deducted.',
    benefit: 'Your days, your invoices and your CIS deductions in one place, matching what HMRC is told. Your monthly and yearly CIS statements are ready when you or your accountant need them for your tax return.',
    uses: [
      { title: 'Records each day', text: 'Submits attendance the same way employees do, so their days can be checked against what they invoice.' },
      { title: 'Their invoices', text: 'Sees the purchase invoices booked against their own supplier account, with gross, deduction, net and payment status.' },
      { title: 'Their CIS deductions', text: 'Opens their own monthly or yearly CIS return to see what was deducted and paid to HMRC on their behalf.' },
      { title: 'Their van', text: 'Sees any vehicle assigned to them, with its fuel and mileage logs.' },
    ],
    where: ['Attendance', 'CIS', 'User'],
    notes: ['Only their own records are visible — never another subcontractor\'s.'],
  },
  {
    id: 'client',
    label: 'Client',
    icon: 'bi-briefcase',
    audience: 'External',
    summary: 'A customer of the company. Looks up the paperwork for their own jobs.',
    benefit: 'A copy of every quote and invoice for your jobs and where each one stands, without emailing for it. Handy when your own accounts team asks for paperwork.',
    uses: [
      { title: 'Their invoices', text: 'Sees every invoice raised to their account and whether it is outstanding, paid or overdue.' },
      { title: 'Quotes and projects', text: 'Sees the quotes sent to them and the projects on their account.' },
    ],
    where: ['User'],
    notes: ['Read-only, and limited to their own customer account.'],
  },
  {
    id: 'hmrc',
    label: 'HMRC',
    icon: 'bi-bank',
    audience: 'External',
    summary: 'An HMRC officer checking CIS compliance. Reads, never changes.',
    uses: [
      { title: 'Checks subcontractors', text: 'Reads supplier records for verification details and deduction rates, and the Subcontractors overview.' },
      { title: 'Checks returns', text: 'Opens the CIS dashboard for any month and the monthly and yearly returns.' },
    ],
    where: ['CIS'],
    notes: ['Read-only: nothing can be created, edited or deleted.'],
  },
  {
    id: 'auditor',
    label: 'Auditor',
    icon: 'bi-clipboard-check',
    audience: 'External',
    summary: 'An outside accountant reviewing the bank reconciliation. Looks, and changes nothing.',
    uses: [
      { title: 'Reviews the reconciliation', text: 'Opens the read-only accountant portal to see matches and signed-off periods. The pages that make changes are out of reach entirely, not just hidden.' },
    ],
    where: ['Accountant'],
    notes: ['Two-factor authentication is required.'],
  },
  {
    id: 'none',
    label: 'No role yet',
    icon: 'bi-hourglass-split',
    audience: 'Anyone',
    summary: 'A new account waiting for an admin to set it up.',
    uses: [
      { title: 'Waits', text: 'Can sign in and manage their own account settings, but sees no business data until an admin gives the account a role.' },
    ],
    where: ['User'],
  },
];

// Day-to-day prose per job role, keyed by accessGroupsConfig.jobRoles slug.
export const jobRoles = {
  director: [
    { title: 'Sees the whole business', text: 'Every department dashboard and overview, with values, so they can see how jobs, money and people are tracking.' },
    { title: 'Signs things off', text: 'Approves across every business area — attendance, holidays, CIS, documents — without holding the keys to the system itself.' },
    { title: 'Sends money out, with a second person', text: 'Can send invoices to KashFlow, pay suppliers, sign off the bank and submit payroll to HMRC and the pension provider, but not on anything they entered, locked or confirmed themselves: someone else does that step.' },
  ],
  contractsManager: [
    { title: 'Runs their jobs', text: 'Projects, quotes, contracts and the purchases booked against them, from award to final account.' },
    { title: 'Labour and plant', text: 'Plans who is where in the weekly assignments, gives attendance its final approval once the site has approved it, and checks which subcontractors are verified and at what rate.' },
  ],
  quantitySurveyor: [
    { title: 'Prices and values work', text: 'Works on quotes, projects and contracts, and reads the purchases booked to a job to track cost against value.' },
    { title: 'Checks subcontractors', text: 'Sees which subcontractors are CIS-verified and at what deduction rate.' },
  ],
  siteManager: [
    { title: 'Their sites only', text: 'Sees the contracts that name them as a site manager and are not yet Completed, with the project, quotes, location, assignments, attendance and vehicle deployments for each.' },
    { title: 'Records and approves the day', text: 'Records a day for the people on their sites with Record a day on the daily page, and gives the first, site approval. A contracts manager then gives the final approval before it counts for payroll.' },
  ],
  supervisor: [
    { title: 'Their gang', text: 'Sees the contracts that name them and the assignments and attendance on them, so they know who should be where.' },
    { title: 'Records the day', text: 'Records a day for the people on their sites from the daily page, ready for the site manager to approve.' },
  ],
  officeManager: [
    { title: 'Documents', text: 'Works the document queues: checks what has arrived and enters invoice details ready for an admin to send on.' },
    { title: 'HR admin and fleet paperwork', text: 'Holidays, tasks, and vehicle records — MOT, insurance and tax dates — without seeing pay.' },
  ],
  payrollHr: [
    { title: 'Pay', text: 'Employee records, pay runs and the weekly flow that feeds them; an admin makes the HMRC submission.' },
    { title: 'People', text: 'Holidays and their approval, starters and leavers, absence.' },
  ],
  healthSafetyAdvisor: [
    { title: 'Across every site', text: 'Reads attendance to see who has been on which site. RAMS, inductions and training records are coming in a later release.' },
  ],
  fleetManager: [
    { title: 'Vehicles and plant', text: 'Keeps every vehicle\'s MOT, insurance, tax and servicing up to date, with fuel and mileage logs and which job each van is deployed to.' },
  ],
};

export default { roles, jobRoles };
