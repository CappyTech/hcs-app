module.exports = {
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
        description: 'Manage OCR documents imported from Paperless-ngx.',
        link: '/paperless/ocr',
        department: ['paperless'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
    ExternalPaperlessngx: {
        title: 'External Document Management',
        description: 'Access the external Paperless-ngx document management system.',
        link: 'https://docs.heroncs.co.uk',
        department: ['paperless'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'

    },
    ExternalPayroll: {
        title: 'KashFlow Payroll',
        description: 'Access the external payroll management system.',
        link: 'https://go.kashflowpayroll.com/Users/SignIn',
        department: ['payroll'],
        buttonClass: 'bg-blue-700 hover:bg-blue-800 bi bi-box-arrow-up-right'
    }
};