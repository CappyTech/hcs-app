const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const renderCreateEmployeeForm = (req, res) => {
    try {
        res.render(path.join('employees', 'createEmployee'), {
            
        });
    } catch (error) {
        logger.error('Error creating employee: ' + error.message);
        req.flash('error', 'Failed to create employee.');
        res.redirect('/employee/create');
    }
};

const renderUpdateEmployeeForm = async (req, res, next) => {
    try {
        const employee = await db.Employees.findByPk(req.params.employee);
        if (!employee) {
            req.flash('error', 'Employee not found.');
            return res.redirect('/employee');
        }
        res.render(path.join('employees', 'updateEmployee'), {
            employee,
            
        });
    } catch (error) {
        logger.error('Error fetching employee: ' + error.message);
        req.flash('error', 'Failed to fetch employee.');
        res.redirect('/employee');
    }
};

router.get('/create',  authService.ensureRoles('admin'), renderCreateEmployeeForm);
router.get('/update/:employee',  authService.ensureRoles('admin'), renderUpdateEmployeeForm);

module.exports = router;