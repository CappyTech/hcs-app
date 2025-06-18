const express = require('express');
const router = express.Router();
const path = require('path');
const logger = require('../../services/loggerService');
const attendanceService = require('../../services/attendanceService');
const authService = require('../../services/authService');
const taxService = require('../../services/taxService');
const db = require('../../services/sequelizeDatabaseService');
const kf = require('../../services/kashflowDatabaseService');
const dateService = require('../../services/dateService');

const createAttendance = async (req, res, next) => {
    try {
        const { date, locationId, projectId, employeeId, subcontractorId, type, hoursWorked, dayRate } = req.body;

        // Ensure only one of locationId or projectId is provided
        if (locationId && projectId) {
            req.flash('error', 'You can only assign either a location OR a project, not both.');
            return res.redirect('/attendance/create');
        }
        if (!locationId && !projectId) {
            req.flash('error', 'You must assign either a location OR a project.');
            return res.redirect('/attendance/create');
        }

        // Ensure only one of hoursWorked or dayRate is provided
        if (hoursWorked && dayRate) {
            req.flash('error', 'You can only enter either hours worked OR a day rate, not both.');
            return res.redirect('/attendance/create');
        }

        // Validate projectId (if provided) exists in KF_Projects (manually fetching since it's in a different DB)
        if (projectId) {
            const projectExists = await kf.KF_Projects.findByPk(projectId);
            if (!projectExists) {
                req.flash('error', 'Invalid Project ID. Please select a valid project.');
                return res.redirect('/attendance/create');
            }
        }

        await db.Attendances.create({
            date,
            locationId: locationId || null,
            projectId: projectId || null,
            employeeId: employeeId || null,
            subcontractorId: subcontractorId || null,
            type,
            hoursWorked: hoursWorked || null,
            dayRate: dayRate || null,
        });

        req.flash('success', 'Attendance record created successfully.');
        res.redirect('/attendance/weekly');
    } catch (error) {
        logger.error('Error creating attendance: ' + error.message);
        req.flash('error', 'Failed to create attendance.');
        next(error);
    }
};


const readAttendance = async (req, res, next) => {
    try {
        const attendance = await db.Attendances.findByPk(req.params.attendance, {
            include: [
                { model: db.Employees },
                { model: db.Subcontractors },
                { model: db.Locations }
            ]
        });

        if (!attendance) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }

        let project = null;
        if (attendance.projectId) {
            project = await kf.KF_Projects.findByPk(attendance.projectId);
        }

        res.render(path.join('attendance', 'viewAttendance'), {
            title: 'Attendance Details',
            attendance,
            project,
        });
    } catch (error) {
        logger.error('Error viewing attendance: ' + error.message);
        req.flash('error', 'Error viewing attendance: ' + error.message);
        next(error);
    }
};



const updateAttendance = async (req, res, next) => {
    try {
        const { attendance } = req.params;
        const { date, locationId, projectId, employeeId, subcontractorId, hoursWorked, type, dayRate } = req.body;

        // Ensure only one of locationId or projectId is provided
        if (locationId && projectId) {
            req.flash('error', 'You can only assign either a location OR a project, not both.');
            return res.redirect(`/attendance/update/${attendance}`);
        }
        if (!locationId && !projectId) {
            req.flash('error', 'You must assign either a location OR a project.');
            return res.redirect(`/attendance/update/${attendance}`);
        }

        // Ensure only one of hoursWorked or dayRate is provided
        if (hoursWorked && dayRate) {
            req.flash('error', 'You can only enter either hours worked OR a day rate, not both.');
            return res.redirect(`/attendance/update/${attendance}`);
        }

        // Validate projectId (if provided) exists in KF_Projects
        if (projectId) {
            const projectExists = await kf.KF_Projects.findByPk(projectId);
            if (!projectExists) {
                req.flash('error', 'Invalid Project ID. Please select a valid project.');
                return res.redirect(`/attendance/update/${attendance}`);
            }
        }

        await db.Attendances.update(
            {
                date,
                locationId: locationId || null,
                projectId: projectId || null,
                employeeId: employeeId || null,
                subcontractorId: subcontractorId || null,
                hoursWorked: employeeId ? hoursWorked || null : null, // Set to null if not an employee
                dayRate: dayRate || null,
                type,
            },
            { where: { id: attendance } }
        );

        req.flash('success', 'Attendance record updated successfully.');
        res.redirect('/attendance/weekly');
    } catch (error) {
        logger.error('Error updating attendance: ' + error.message);
        req.flash('error', `Failed to update attendance: ${error.message}`);
        res.redirect(`/`);
    }
};



const deleteAttendance = async (req, res, next) => {
    try {
        const attendance = req.params.attendance;

        await db.Attendances.destroy({ where: { id: attendance } });

        req.flash('success', 'Attendance record deleted successfully.');
        res.redirect('/dashboard/attendance');
    } catch (error) {
        logger.error('Error deleting attendance: ' + error.message);
        req.flash('error', 'Failed to delete attendance.');
        next(error); // Pass the error to the error handler
    }
};

router.get('/fetch/attendance/:id',  authService.ensureRole(), async (req, res, next) => {
    try {
        const attendance = await db.Attendances.findOne({
            where: { id: req.params.id },
            include: [
                { model: db.Employees },
                { model: db.Subcontractors },
                { model: db.Locations }
            ]
        });

        if (!attendance) {
            return res.status(404).json({ error: 'Attendance record not found' });
        }

        res.json({ attendance });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch attendance', details: error.message });
    }
});


router.post('/create',  authService.ensureRole(), createAttendance);
router.get('/read/:attendance',  authService.ensureRole(), readAttendance);
router.post('/update/:attendance',  authService.ensureRole(), updateAttendance);
router.post('/delete/:attendance',  authService.ensureRole(), deleteAttendance);

module.exports = router;