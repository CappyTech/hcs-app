/**
 * Presentation metadata for department dashboard tiles, keyed by tile key
 * (a model name for model-driven tiles, or the dashboardTilesConfig key for
 * custom tiles). Everything here is optional — a tile with no entry falls back
 * to a default icon and the ungrouped bucket, so it still renders cleanly.
 *
 * Grouping is department-scoped on purpose: the same model (e.g. holidayRequest)
 * sits under "Holiday" in HR but shouldn't force a stray group split in
 * Management, which has no group map and renders as one flat list.
 */

const tileIcons = {
  // People / HR
  employee: 'bi-people',
  user: 'bi-person-badge',
  task: 'bi-check2-square',
  holiday: 'bi-calendar2-week',
  employeeHoliday: 'bi-calendar-heart',
  holidayRequest: 'bi-calendar-check',
  holidayDismissal: 'bi-calendar-x',
  holidayCustom: 'bi-calendar-event',
  attendance: 'bi-clock',
  // Finance
  supplier: 'bi-building',
  customer: 'bi-person-vcard',
  invoice: 'bi-receipt',
  purchase: 'bi-bag',
  quote: 'bi-file-earmark-text',
  project: 'bi-clipboard-check',
  nominal: 'bi-list-columns',
  vatrate: 'bi-percent',
  vatReturn: 'bi-file-earmark-spreadsheet',
  journal: 'bi-journal-text',
  accountingPeriod: 'bi-calendar-range',
  country: 'bi-globe',
  currency: 'bi-currency-exchange',
  quoteCategory: 'bi-tags',
  purchaseOrderCategory: 'bi-tags',
  // CIS
  subcontractor: 'bi-person-gear',
  // Maintenance / fleet
  vehicle: 'bi-truck',
  vehicleFuelLog: 'bi-fuel-pump',
  vehicleMileageLog: 'bi-speedometer2',
  vehicleService: 'bi-wrench',
  // Management
  assignment: 'bi-person-workspace',
  contract: 'bi-file-earmark-text',
  location: 'bi-geo-alt',
  note: 'bi-journal-text',
  // Documents
  OcrDocument: 'bi-file-earmark-text',
  OcrDocumentIngest: 'bi-arrow-repeat',
  // Custom tiles (dashboardTilesConfig keys)
  DeletedItems: 'bi-trash',
  LogViewer: 'bi-terminal',
  BackgroundJobs: 'bi-gear-wide-connected',
  SecurityEvents: 'bi-shield-lock',
  AuditLog: 'bi-clipboard-data',
  MaintenanceMode: 'bi-cone-striped',
  ConnectionSettings: 'bi-sliders',
  EmailDashboard: 'bi-envelope',
  ApiReference: 'bi-code-slash',
  UiGuidelines: 'bi-palette',
  GdprCompliance: 'bi-shield-check',
  MailFilteringLog: 'bi-funnel',
  UserProfile: 'bi-person-circle',
  UserSettings: 'bi-gear',
  GdprRequests: 'bi-file-earmark-lock',
  NotificationSettings: 'bi-bell',
  Logout: 'bi-box-arrow-right',
  SubmitAttendance: 'bi-clock',
  MyDailyAttendance: 'bi-clock',
  MyWeeklyAttendance: 'bi-calendar-week',
  DailyAttendance: 'bi-clock',
  WeeklyAttendance: 'bi-calendar-week',
  WeeklyAttendanceManagement: 'bi-calendar-week',
  CISDashboard: 'bi-speedometer2',
  MonthlyReturns: 'bi-file-earmark-text',
  AssignSubcontractors: 'bi-person-gear',
  InternalPayroll: 'bi-cash-coin',
  ExternalPayroll: 'bi-box-arrow-up-right',
  BankReconciliation: 'bi-bank',
  BankExceptions: 'bi-exclamation-triangle',
  BulkPayment: 'bi-cash-stack',
  Paperlessngx: 'bi-file-earmark-text',
  ExternalPaperlessngx: 'bi-box-arrow-up-right',
  CompanyDocs: 'bi-file-earmark-richtext',
  WebsiteCaseStudies: 'bi-journal-richtext',
  WebsitePosts: 'bi-newspaper',
  WebsiteServices: 'bi-grid',
  WebsiteAccreditations: 'bi-award',
  WebsiteMedia: 'bi-images',
  WebsiteSettings: 'bi-gear',
  ExternalOneDrive: 'bi-cloud',
};

// Department-scoped groups. Only departments listed here render grouped headings;
// everything else renders as one flat list.
const tileGroups = {
  'human-resources': {
    employee: 'People',
    task: 'People',
    holiday: 'Holiday',
    employeeHoliday: 'Holiday',
    holidayRequest: 'Holiday',
    holidayDismissal: 'Holiday',
    holidayCustom: 'Holiday',
    DailyAttendance: 'Attendance',
    WeeklyAttendance: 'Attendance',
  },
};

const DEFAULT_ICON = 'bi-table';
const DEFAULT_GROUP = 'General';

function iconFor(tileKey) {
  return tileIcons[tileKey] || DEFAULT_ICON;
}
function groupFor(department, tileKey) {
  return (tileGroups[department] && tileGroups[department][tileKey]) || DEFAULT_GROUP;
}

export default { tileIcons, tileGroups, iconFor, groupFor, DEFAULT_ICON, DEFAULT_GROUP };
