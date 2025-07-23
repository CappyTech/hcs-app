module.exports = {
    WeeklyAttendance: {
        title: 'Weekly Attendance',
        description: 'View weekly attendance records',
        link: '/weekly',
        department: ['payroll', 'human-resources'],
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
        link: '/CIS',
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

    KF_Invoices: {
        title: 'KF Invoices',
        description: 'View KF Invoices',
        link: '/KF/invoices',
        department: ['kashflow'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
}