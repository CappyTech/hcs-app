const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const kf = require('../../services/kashflowDatabaseService');
const authService = require('../../services/authService');
const dateService = require('../../services/dateService');

const renderAttendanceCreateForm = async (req, res, next) => {
    try {
        const { date, employeeId, subcontractorId } = req.query;
        const locations = await db.Locations.findAll();
        const employees = await db.Employees.findAll();
        const subcontractors = await kf.KF_Suppliers.findAll({
            where: {
                Subcontractor: true  // ✅ Boolean value (true) instead of 1
            },
            order: [['Name', 'ASC']]
        });        
        const projects = await kf.KF_Projects.findAll({
            where: {
                Status: 1
            },
            order: [['Number', 'DESC']]
        });

        res.render(path.join('attendance', 'createAttendance'), {
            date: date ? dateService.slimDateTime(date, false, true) : '',
            employeeId: employeeId ?? null,
            subcontractorId: subcontractorId ?? null,
            title: 'Create Attendance',
            locations: locations,
            employees: employees,
            subcontractors: subcontractors,
            projects: projects,
        });
    } catch (error) {
        logger.error('Error rendering Attendance create form: ' + error.message);
        req.flash('error', 'Error rendering Attendance create form: ' + error.message);
        next(error);
    }
};


const renderAttendanceUpdateForm = async (req, res, next) => {
    try {
        const attendance = await db.Attendances.findByPk(req.params.attendance);

        if (!attendance) {
            return res.status(404).send('Attendance not found');
        }

        const locations = await db.Locations.findAll();
        const employees = await db.Employees.findAll();
        const subcontractors = await kf.KF_Suppliers.findAll();
        const projects = await kf.KF_Projects.findAll({});

        res.render(path.join('attendance', 'updateAttendance'), {
            title: 'Update Attendance',
            attendance: attendance,
            locations: locations,
            employees: employees,
            subcontractors: subcontractors,
            projects: projects,
        });
    } catch (error) {
        logger.error('Error rendering Attendance update form: ' + error.message);
        req.flash('error', 'Error rendering Attendance update form: ' + error.message);
        next(error);
    }
};



router.get('/create',  authService.ensureRole(), renderAttendanceCreateForm);
router.get('/update/:attendance',  authService.ensureRole(), renderAttendanceUpdateForm);

module.exports = router;