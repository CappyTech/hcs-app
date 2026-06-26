module.exports = {
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
    GdprRequests: {
        title: 'My GDPR Requests',
        description: 'Submit or track your data subject rights requests (access, erasure, rectification, etc.).',
        link: '/gdpr/requests',
        department: ['user'],
        buttonClass: 'bg-green-600 hover:bg-green-700'
    },
    SubmitAttendance: {
        title: 'Submit Attendance',
        description: 'Submit your daily attendance records.',
        link: '/attendance/submit',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    MyDailyAttendance: {
        title: 'Your Daily Attendance',
        description: 'View your daily attendance history.',
        link: '/daily',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    MyWeeklyAttendance: {
        title: 'Your Weekly Attendance',
        description: 'View your weekly attendance history.',
        link: '/weekly',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    WeeklyAttendance: {
        title: 'Weekly Attendance',
        description: 'View weekly attendance records',
        link: '/weekly',
        department: ['payroll', 'human-resources'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    WeeklyAttendanceManagement: {
        title: 'Weekly Attendance',
        description: 'View weekly attendance records',
        link: '/weekly-management',
        department: ['management'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    DailyAttendance: {
        title: 'Daily Attendance',
        description: 'View daily attendance records',
        link: '/daily',
        department: ['payroll', 'human-resources'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
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
    KF_Customers: {
        title: 'KF Customers',
        description: 'View KF Customers',
        link: 'https://app.kashflow.com/#customers',
        department: ['kashflow'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Invoices: {
        title: 'KF Invoices',
        description: 'View KF Invoices',
        link: 'https://app.kashflow.com/#invoices',
        department: ['kashflow'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Projects: {
        title: 'KF Projects',
        description: 'View KF Projects',
        link: 'https://app.kashflow.com/projects.asp',
        department: ['kashflow'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Quotes: {
        title: 'KF Quotes',
        description: 'View KF Quotes',
        link: 'https://app.kashflow.com/#quotes',
        department: ['kashflow'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Receipts: {
        title: 'KF Receipts',
        description: 'View KF Receipts',
        link: 'https://app.kashflow.com/#receipts',
        department: ['kashflow'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    KF_Suppliers: {
        title: 'KF Suppliers',
        description: 'View KF Suppliers',
        link: 'https://app.kashflow.com/#suppliers',
        department: ['kashflow'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    Paperlessngx: {
        title: 'Document Management',
        description: 'Manage OCR documents imported from docs.heroncs.co.uk.',
        link: '/paperless/ocr',
        department: ['paperless'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    ExternalPaperlessngx: {
        title: 'External Document Management',
        description: 'Access the external purchase invoice document management system.',
        link: 'https://docs.heroncs.co.uk',
        department: ['paperless'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'

    },
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
    ExternalOneDrive: {
        title: 'Microsoft OneDrive',
        description: 'Access OneDrive for document storage and management.',
        link: 'https://heroncscouk-my.sharepoint.com/',
        department: ['management'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    },
    FleetManagement: {
        title: 'Fleet Overview',
        description: 'Manage company vehicles, compliance and assignments.',
        link: '/overview/fleet',
        department: ['maintenance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
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
    },
    UserProfile: {
        title: 'Profile',
        description: 'View and manage your profile information.',
        link: '/user/profile',
        department: ['user'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    UserSettings: {
        title: 'Settings',
        description: 'Manage your account and preferences.',
        link: '/user/account',
        department: ['user'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    TwoFactorAuth: {
        title: 'Two-Factor Auth',
        description: 'Set up or manage your TOTP two-factor authentication.',
        // 2FA setup/management lives on the account page. /user/2fa is the
        // pre-login challenge and only works mid-login (requires userPending2FA).
        link: '/user/account',
        department: ['user'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    Logout: {
        title: 'Logout',
        description: 'Sign out of your account.',
        link: '/user/logout',
        department: ['user'],
        buttonClass: 'bg-red-700 hover:bg-red-800'
    }
};