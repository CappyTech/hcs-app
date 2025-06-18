/**
 * @fileoverview Controller for handling daily attendance routes.
 * 
 * @module controllers/dailyAttendance
 */

const express = require('express');
const router = express.Router();
const moment = require('moment');
const path = require('path');
const logger = require('../services/loggerService');
const attendanceService = require('../services/attendanceService');
const authService = require('../services/authService');

/**
 * Get daily attendance for a specific date or the current date if not provided.
 * 
 * @async
 * @function getDailyAttendance
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @param {Function} next - Express next middleware function.
 * @returns {Promise<void>}
 */
const getDailyAttendance = async (req, res, next) => {
    const date = req.params.date || moment().format('YYYY-MM-DD'); // Default to today
    try {
        const attendance = await attendanceService.getAttendanceForDay(date);
        
        res.render(path.join('attendance', 'daily'), {
            moment,
            attendance,
            date,
            currentTab: 'daily'
        });
    } catch (error) {
        logger.error('Error fetching daily attendance: ' + error.message);
        req.flash('error', 'Error fetching daily attendance: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

/**
 * Route to get daily attendance.
 * 
 * @name get/daily/:date?
 * @function
 * @memberof module:controllers/dailyAttendance
 * @inner
 * @param {string} [date] - Optional date parameter in 'YYYY-MM-DD' format.
 * @param {Function} authService.ensureAuthenticated - Middleware to ensure user is authenticated.
 * @param {Function} authService.ensureRoles - Middleware to ensure user has 'admin' role.
 * @param {Function} getDailyAttendance - Controller function to handle the route.
 */
router.get('/daily/:date?',  authService.ensureRole(), getDailyAttendance);

module.exports = router;