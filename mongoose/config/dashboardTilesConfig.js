/**
 * Custom dashboard tiles, grouped by department (see departmentsConfig.js
 * for the canonical department registry). Model-backed tiles are generated
 * from listControllerConfig.js — this file is for everything else:
 * admin tools, external links, and workflow shortcuts.
 */
module.exports = {
    // ── Admin ─────────────────────────────────────────────────────────
    DeletedItems: {
        title: 'Deleted Items',
        description: 'Browse and recover soft-deleted records.',
        link: '/admin/deleted-items',
        department: ['admin'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    LogViewer: {
        title: 'System Logs',
        description: 'View and monitor real-time application logs.',
        link: '/logs',
        department: ['admin'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    BackgroundJobs: {
        title: 'Background Jobs',
        description: 'Monitor scheduled tasks, notification outbox, and trigger jobs manually.',
        link: '/admin/jobs',
        department: ['admin'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    SecurityEvents: {
        title: 'Security Events',
        description: 'Audit trail of logins, lockouts, password and 2FA changes.',
        link: '/admin/security-events',
        department: ['admin'],
        buttonClass: 'bg-red-700 hover:bg-red-800'
    },
    AuditLog: {
        title: 'Audit Log',
        description: 'Database audit trail of all record changes and sensitive reads, with actor attribution.',
        link: '/audit',
        department: ['admin'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    MaintenanceMode: {
        title: 'Maintenance Mode',
        description: 'Take the app offline for non-admins or announce a maintenance window.',
        link: '/admin/maintenance',
        department: ['admin'],
        buttonClass: 'bg-amber-700 hover:bg-amber-800'
    },
    AdminSettings: {
        title: 'Settings',
        description: 'Manage your account settings, password, and preferences.',
        link: '/user/account',
        department: ['admin'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    ConnectionSettings: {
        title: 'External Connections',
        description: 'Configure KashFlow API, SMTP email, and Paperless-ngx credentials.',
        link: '/admin/connections',
        department: ['admin'],
        buttonClass: 'bg-indigo-700 hover:bg-indigo-800'
    },
    EmailDashboard: {
        title: 'Email & Notifications',
        description: 'Manage notification types, compose emails to users, and view the delivery outbox.',
        link: '/admin/emails',
        department: ['admin'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800'
    },
    ApiReference: {
        title: 'KashFlow API',
        description: 'Internal KashFlow REST API documentation — request fields, response-only fields, and integration notes.',
        link: '/help/api',
        department: ['admin'],
        buttonClass: 'bg-violet-700 hover:bg-violet-800'
    },
    UiGuidelines: {
        title: 'UI Component Board',
        description: 'Living reference for every UI pattern, component, colour, and layout used in this application.',
        link: '/admin/ui-guidelines',
        department: ['admin'],
        buttonClass: 'bg-slate-700 hover:bg-slate-800'
    },
    GdprCompliance: {
        title: 'GDPR Compliance',
        description: 'Open RoPA, DPIA template, incident response playbook, and GDPR evidence links.',
        link: '/admin/gdpr',
        department: ['admin'],
        buttonClass: 'bg-emerald-700 hover:bg-emerald-800'
    },

    // ── User ──────────────────────────────────────────────────────────
    UserProfile: {
        title: 'Profile',
        description: 'View and manage your profile information.',
        link: '/user/profile',
        department: ['user'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    UserSettings: {
        title: 'Settings',
        description: 'Manage your account, password, preferences, and two-factor authentication.',
        link: '/user/account',
        department: ['user'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    GdprRequests: {
        title: 'My GDPR Requests',
        description: 'Submit or track your data subject rights requests (access, erasure, rectification, etc.).',
        link: '/gdpr/requests',
        department: ['user'],
        buttonClass: 'bg-green-600 hover:bg-green-700'
    },
    NotificationSettings: {
        title: 'Notification Settings',
        description: 'Choose which emails you receive, preview them, and control admin contact.',
        link: '/user/account/settings/notifications',
        department: ['user', 'admin'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    Logout: {
        title: 'Logout',
        description: 'Sign out of your account.',
        link: '/user/logout',
        department: ['user'],
        buttonClass: 'bg-red-700 hover:bg-red-800'
    },

    // ── Attendance ────────────────────────────────────────────────────
    SubmitAttendance: {
        title: 'Submit Attendance',
        description: 'Submit your daily attendance records.',
        link: '/attendance/submit',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    MyDailyAttendance: {
        title: 'Your Daily Attendance',
        description: 'View your daily attendance history.',
        link: '/daily',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    MyWeeklyAttendance: {
        title: 'Your Weekly Attendance',
        description: 'View your weekly attendance history.',
        link: '/weekly',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    DailyAttendance: {
        title: 'Daily Attendance',
        description: 'View daily attendance records',
        link: '/daily',
        department: ['payroll', 'human-resources'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    WeeklyAttendance: {
        title: 'Weekly Attendance',
        description: 'View weekly attendance records',
        link: '/weekly',
        department: ['payroll', 'human-resources'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    WeeklyAttendanceManagement: {
        title: 'Weekly Attendance (Management)',
        description: 'Weekly attendance management view with approvals.',
        link: '/weekly-management',
        department: ['management'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },

    // ── Construction Industry Scheme ──────────────────────────────────
    CISDashboard: {
        title: 'CIS Dashboard',
        description: 'Submit CIS returns.',
        link: '/CIS/Dashboard/',
        department: ['construction-industry-scheme'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    MonthlyReturns: {
        title: 'CIS Returns Reports',
        description: 'View Monthly and Yearly Returns',
        link: '/CIS/returns/form',
        department: ['construction-industry-scheme'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    AssignSubcontractors: {
        title: 'Edit CIS Details',
        description: 'Edit subcontractor CIS details.',
        link: '/subcontractor/assign',
        department: ['construction-industry-scheme'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },

    // ── Finance (incl. former KashFlow department) ────────────────────
    PayrollOverview: {
        title: 'Payroll Overview',
        description: 'Tax year summary, monthly breakdown, and HMRC submissions.',
        link: '/overview/payroll',
        department: ['payroll', 'finance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    InternalPayroll: {
        title: 'Payroll',
        description: 'Run payroll, view submissions, and manage PAYE settings.',
        link: '/payroll/dashboard',
        department: ['payroll', 'finance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    ExternalPayroll: {
        title: 'KashFlow Payroll',
        description: 'Access the external payroll management system.',
        link: 'https://go.kashflowpayroll.com/Users/SignIn',
        department: ['finance', 'payroll'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Customers: {
        title: 'KF Customers',
        description: 'View KF Customers',
        link: 'https://app.kashflow.com/#customers',
        department: ['finance'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Invoices: {
        title: 'KF Invoices',
        description: 'View KF Invoices',
        link: 'https://app.kashflow.com/#invoices',
        department: ['finance'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Projects: {
        title: 'KF Projects',
        description: 'View KF Projects',
        link: 'https://app.kashflow.com/projects.asp',
        department: ['finance'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Quotes: {
        title: 'KF Quotes',
        description: 'View KF Quotes',
        link: 'https://app.kashflow.com/#quotes',
        department: ['finance'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Receipts: {
        title: 'KF Receipts',
        description: 'View KF Receipts',
        link: 'https://app.kashflow.com/#receipts',
        department: ['finance'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Suppliers: {
        title: 'KF Suppliers',
        description: 'View KF Suppliers',
        link: 'https://app.kashflow.com/#suppliers',
        department: ['finance'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },

    // ── Documents (Paperless OCR + company docs) ──────────────────────
    Paperlessngx: {
        title: 'Document Management',
        description: 'Manage OCR documents imported from docs.heroncs.co.uk.',
        link: '/paperless/ocr',
        department: ['documents'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    ExternalPaperlessngx: {
        title: 'External Document Management',
        description: 'Access the external purchase invoice document management system.',
        link: 'https://docs.heroncs.co.uk',
        department: ['documents'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    CompanyDocs: {
        title: 'Letterhead & Policies',
        description: 'Manage the company letterhead and internal policy documents.',
        link: '/company-docs',
        department: ['documents'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },

    // ── Management ────────────────────────────────────────────────────
    ExternalOneDrive: {
        title: 'Microsoft OneDrive',
        description: 'Access OneDrive for document storage and management.',
        link: 'https://heroncscouk-my.sharepoint.com/',
        department: ['management'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },

    // ── Maintenance ───────────────────────────────────────────────────
    FleetManagement: {
        title: 'Fleet Overview',
        description: 'Manage company vehicles, compliance and assignments.',
        link: '/overview/fleet',
        department: ['maintenance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },

    // ── Human Resources ───────────────────────────────────────────────
    HolidayManagement: {
        title: 'Holiday Overview',
        description: 'Manage holiday accrual, requests and approvals.',
        link: '/overview/holiday',
        department: ['human-resources', 'management'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    HolidayRequests: {
        title: 'Holiday Requests',
        description: 'Review, approve and reject employee holiday requests.',
        link: '/holidayRequests',
        department: ['human-resources', 'management'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    }
};
