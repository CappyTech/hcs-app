/**
 * Optional modules — the parts of the app a company can switch off.
 *
 * hcs-app is deployed once per company, and not every company does CIS, runs
 * payroll in-house or keeps a fleet. Each module here can be turned off on
 * Admin → Configuration → Modules (MODULE_<ID> = false). Every module is on
 * unless switched off, so an existing install changes nothing.
 *
 * What is not listed is core and always on: people and HR, attendance,
 * holiday, tasks, contracts and projects, policies, users and admin.
 *
 * A module that is off is off for everyone, admins included:
 *   - its pages answer 404 (moduleService.gate, ahead of authentication, so
 *     webhooks and APIs stop too);
 *   - rolePermissionsConfig refuses its routes, departments and models, so the
 *     navigation, home, overview tiles, lists and create menu drop it;
 *   - its background jobs skip their runs, its help is hidden and search
 *     leaves its records out.
 * Nothing is deleted. Switching it back on brings everything back as it was.
 *
 * Fields:
 *   id          config key is MODULE_<ID upper-snake>
 *   label, description   shown on the Configuration page
 *   requires    modules this one cannot work without; it is off whenever any
 *               of them is
 *   paths       URL prefixes it owns (prefix = the path itself or anything
 *               below it), matched case-insensitively like Express routes
 *   models      models it owns; their generic pages (/<model>, /<model>s and
 *               /overview/<model>) are included automatically
 *   departments departmentsConfig slugs it owns
 *   help        help category ids and article ids it owns
 *   jobs        jobRegistry names that skip while it is off
 *
 * Keep this file dependency-free: rolePermissionsConfig reads it through
 * moduleService, and everything imports rolePermissionsConfig.
 */
export default [
  {
    id: 'finance',
    label: 'Finance',
    description: 'Invoices, purchases, customers, quotes, the chart of accounts and the accountant portal, read from the accounting system (KashFlow) by hcs-sync. Suppliers and projects stay, because attendance and contracts use them.',
    paths: ['/finance', '/overview/finance', '/accountant', '/kashflow', '/receipts', '/countries', '/currencies', '/quotecategories', '/purchaseordercategories'],
    models: [
      'invoice', 'purchase', 'customer', 'quote', 'nominal', 'vatRate', 'vatReturn', 'journal', 'product',
      'accountingPeriod', 'currency', 'country', 'quoteCategory', 'purchaseOrder', 'purchaseOrderCategory',
      'bankAccount', 'bankTransaction', 'bankReconciliation',
    ],
    departments: ['finance', 'accountant-portal'],
    help: ['finance', 'client-portal'],
    jobs: [],
  },
  {
    id: 'cis',
    label: 'Construction Industry Scheme',
    description: 'Subcontractor deduction rates, HMRC verification, the CIS dashboard and monthly returns.',
    requires: ['finance'],
    paths: ['/CIS', '/construction-industry-scheme', '/subcontractor', '/supplier/change', '/overview/subcontractors', '/overview/subcontractor', '/overview/cisReturn'],
    models: [],
    departments: ['construction-industry-scheme'],
    help: ['cis', 'subcontractor-cis', 'compliance-cis-scope', 'hmrc-role'],
    jobs: ['cis-return-reminder', 'paperless-cis-check'],
  },
  {
    id: 'bank',
    label: 'Bank reconciliation and payments',
    description: 'Statement import, matching against the accounts, period sign-off and paying several supplier invoices at once.',
    requires: ['finance'],
    paths: ['/bank', '/payments'],
    models: ['bankMatch', 'bankRule', 'bankSignOff', 'statementImport', 'statementLine'],
    departments: [],
    help: ['bank-reconciliation', 'bulk-payments'],
    jobs: ['bank-link-resolve', 'bank-rule-apply', 'bank-stranded-lines', 'bank-statement-grab', 'bank-statement-reconcile', 'paperless-read-statements'],
  },
  {
    id: 'job-register',
    label: 'Job Register',
    description: 'Quotes and jobs from enquiry to completion, created in the accounting system.',
    requires: ['finance'],
    paths: ['/job-register'],
    models: ['jobRegister'],
    departments: [],
    help: [],
    jobs: [],
  },
  {
    id: 'payroll',
    label: 'Payroll',
    description: 'Pay runs, PAYE and National Insurance, pensions and HMRC RTI submissions, or, once Staffology is connected and tested, the pay runs, payslips and My pay pages from Staffology. Switch off if payroll is done elsewhere and not wanted here.',
    paths: ['/payroll', '/settings/payroll', '/overview/payroll', '/my-pay'],
    models: ['payrollRun', 'payrollSubmission', 'payrollConfig', 'payrollEntry', 'payrollTaxRates'],
    departments: ['payroll'],
    help: ['payroll'],
    jobs: [],
  },
  {
    id: 'fleet',
    label: 'Fleet',
    description: 'Vehicles, servicing, fuel and mileage logs, deployments and MOT, insurance and tax reminders.',
    paths: ['/maintenance', '/overview/fleet', '/vehicle-deployment'],
    models: ['vehicle', 'vehicleService', 'vehicleFuelLog', 'vehicleMileageLog', 'vehicleDeployment'],
    departments: ['maintenance'],
    help: ['fleet'],
    jobs: ['vehicle-compliance'],
  },
  {
    id: 'health-safety',
    label: 'Health & Safety',
    description: 'Training and cards, site inductions, RAMS and briefings, and the accident book.',
    paths: ['/health-safety', '/overview/healthSafety', '/inductions', '/rams', '/accident-report', '/accidents'],
    models: ['trainingRecord', 'induction', 'rams', 'ramsBriefing', 'accidentReport'],
    departments: ['health-safety'],
    help: ['health-safety'],
    jobs: ['training-expiry'],
  },
  {
    id: 'documents',
    label: 'Documents (Paperless)',
    description: 'Supplier invoices and statements read from Paperless-ngx: the queues, data entry and sending to the accounting system.',
    paths: ['/paperless', '/documents', '/overview/documents', '/api/paperless', '/statement'],
    models: [],
    departments: ['documents'],
    help: ['documents'],
    jobs: [
      'paperless-ocr-grab', 'paperless-ingest-reconcile', 'paperless-read-documents', 'paperless-repair-unmarked-sends',
      'paperless-exclusion-tags', 'paperless-type-check', 'paperless-notification-retry', 'paperless-shadow-report',
      'paperless-mail-rules', 'paperless-correspondent-sync', 'ocr-orphans',
      // Statements arrive through Paperless too; a job listed under two
      // modules skips while either is off.
      'bank-statement-grab', 'bank-statement-reconcile', 'paperless-read-statements', 'paperless-cis-check',
    ],
  },
  {
    id: 'website',
    label: 'Website',
    description: 'The editor for the public website\'s pages, posts and images, and the content API the website reads.',
    paths: ['/website', '/api/web'],
    models: [],
    departments: ['website'],
    help: ['website-editor'],
    jobs: [],
  },
];
