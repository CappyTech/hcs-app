/**
 * What the signed-out home page says the app does.
 *
 * One entry per thing a person can do, grouped the way the navigation groups
 * departments. Every department in departmentsConfig must be named by at least
 * one entry's `departments` (tests/publicFeatures.test.js enforces it), so a new
 * department cannot ship without being listed here.
 *
 * This page is public, so wording describes what people can do, not how the
 * system works inside: no admin tooling, integrations or internal names.
 *
 * Per entry:
 *   id           stable key; admins list ids in PUBLIC_HOME_HIDDEN to leave entries off
 *   departments  department slugs this entry speaks for ([] = app-wide, e.g. search)
 *   icon         Bootstrap Icons class
 *   title, text  what is shown
 *   when         optional condition name, resolved in publicFeaturesService
 *                ('website' = a company website is set)
 *   extra        optional { when, text }: a sentence added only when the condition holds
 *
 * Keep this file dependency-free: configRegistry imports it for its help text.
 */
export default [
  {
    group: 'People',
    icon: 'bi-people',
    items: [
      { id: 'hr', departments: ['human-resources'], icon: 'bi-person-badge', title: 'Human Resources', text: 'Employee records, right-to-work and contract dates, and reminders before anything lapses.' },
      { id: 'attendance', departments: ['attendance'], icon: 'bi-calendar-check', title: 'Attendance', text: 'Daily and weekly attendance, a guided weekly flow for contracts and assignments, and sign-off.' },
      { id: 'holiday', departments: ['human-resources'], icon: 'bi-sun', title: 'Holiday', text: 'Accrual, carry-over, requests and approvals, with bank and company holidays built in.' },
      { id: 'payroll', departments: ['payroll'], icon: 'bi-cash-coin', title: 'Payroll', text: 'Pay runs, year-to-date totals and Real Time Information submissions to HMRC.' },
    ],
  },
  {
    group: 'Money',
    icon: 'bi-wallet2',
    items: [
      { id: 'cis', departments: ['construction-industry-scheme'], icon: 'bi-building', title: 'Construction Industry Scheme', text: 'Subcontractor verification, deduction rates, and monthly and yearly CIS returns.' },
      { id: 'finance', departments: ['finance'], icon: 'bi-receipt', title: 'Finance', text: 'Invoices, purchases, quotes, receipts, customers and suppliers in one place.' },
      { id: 'bank', departments: ['finance'], icon: 'bi-bank', title: 'Bank reconciliation', text: 'Statement matching, exceptions to review and bulk supplier payments.' },
      { id: 'returns', departments: ['accountant-portal'], icon: 'bi-clipboard-data', title: 'Returns & accountant portal', text: 'CIS and VAT return summaries, and a read-only view for the company’s accountant.' },
    ],
  },
  {
    group: 'Work',
    icon: 'bi-briefcase',
    items: [
      { id: 'projects', departments: ['management'], icon: 'bi-clipboard-check', title: 'Projects', text: 'Contracts, weekly assignments and project financial checks.' },
      { id: 'tasks', departments: ['human-resources'], icon: 'bi-list-check', title: 'Tasks', text: 'Personal and shared tasks with due dates, recurring tasks and automatic reminders.' },
      { id: 'fleet', departments: ['maintenance'], icon: 'bi-truck', title: 'Fleet', text: 'Vehicles, MOT, insurance and tax dates, servicing, fuel and mileage logs.' },
      { id: 'documents', departments: ['documents'], icon: 'bi-file-earmark-text', title: 'Documents', text: 'Invoices and statements read automatically, checked, then sent to the accounts.' },
      { id: 'policies', departments: ['documents'], icon: 'bi-journal-text', title: 'Policies', text: 'Company policies, letterhead and review dates in one place.' },
    ],
  },
  {
    group: 'Everyday',
    icon: 'bi-house',
    items: [
      { id: 'home', departments: ['create'], icon: 'bi-speedometer2', title: 'Your own home page', text: 'Overviews for every area, with the figures and lists you choose pinned to home.' },
      { id: 'search', departments: [], icon: 'bi-search', title: 'Search', text: 'One search across everything you are allowed to see.' },
      { id: 'notifications', departments: ['user'], icon: 'bi-bell', title: 'Notifications', text: 'Choose which emails and reminders you receive.' },
      { id: 'website', departments: ['website'], when: 'website', icon: 'bi-globe', title: 'Website', text: 'Case studies, blog posts, services and accreditations for the company website.' },
    ],
  },
  {
    group: 'Security & privacy',
    icon: 'bi-shield-check',
    items: [
      {
        id: 'signin', departments: ['admin'], icon: 'bi-shield-lock', title: 'Secure sign-in',
        text: 'Two-factor authentication, and each person sees only the pages their role allows.',
        extra: { when: 'microsoftSso', text: 'Sign in with your Microsoft work account.' },
      },
      { id: 'privacy', departments: [], icon: 'bi-person-lock', title: 'Privacy', text: 'Make and track data protection requests from your own account.' },
    ],
  },
];
