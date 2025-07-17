module.exports = {
    WeeklyAttendance: {
        title: 'Weekly Attendance',
        description: 'View weekly attendance records',
        link: '/weekly',
        department: ['payroll', 'human-resources'],
        buttonClass: 'bg-indigo-600 hover:bg-indigo-700',
    },
    DailyAttendance: {
        title: 'Daily Attendance',
        description: 'View daily attendance records',
        link: '/daily',
        department: ['payroll', 'human-resources'],
        buttonClass: 'bg-indigo-600 hover:bg-indigo-700',
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
        link: '/monthly/returns/form',
        department: ['construction-industry-scheme'],
        buttonClass: 'bg-green-700 hover:bg-green-800'
    },
}