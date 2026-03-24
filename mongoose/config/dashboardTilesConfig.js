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
    SubmitAttendance: {
        title: 'Submit Attendance',
        description: 'Submit your daily attendance records.',
        link: '/attendance/submit',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    MyDailyAttendance: {
        title: 'My Days',
        description: 'View your daily attendance history.',
        link: '/daily',
        department: ['attendance'],
        buttonClass: 'bg-green-700 hover:bg-green-800',
    },
    MyWeeklyAttendance: {
        title: 'My Weekly',
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
        title: 'Fleet Management',
        description: 'Manage company vehicles, compliance and assignments.',
        link: '/fleet',
        department: ['maintenance'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    HolidayManagement: {
        title: 'Holiday Management',
        description: 'Manage holiday accrual, requests and approvals.',
        link: '/holiday',
        department: ['human-resources', 'management'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    FileManagement: {
        title: 'File Management',
        description: 'Upload, view and manage documents across models.',
        link: '/files',
        department: ['admin'],
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
        link: '/user/2fa',
        department: ['user'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    }
};