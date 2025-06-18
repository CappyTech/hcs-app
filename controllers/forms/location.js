const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const renderLocationCreateForm = async (req, res, next) => {
    try {
        

        logger.info("Accessing /location/create");


        return res.render(path.join('locations', 'createLocation'), {
            title: 'Create Location',
            
        });
    } catch (error) {
        logger.error('Error rendering location create form: ' + error.message);
        req.flash('error', 'Error rendering location create form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const renderLocationUpdateForm = async (req, res, next) => {
    try {
        

        const location = await db.Locations.findByPk(req.params.locationId);

        if (!location) {
            req.flash('error', 'Location not found.');
            return res.redirect('/dashboard/location');
        }

        return res.render(path.join('locations', 'updateLocation'), {
            title: 'Update Location',
            location,
            
        });
    } catch (error) {
        logger.error('Error rendering location update form: ' + error.message);
        req.flash('error', 'Error rendering location update form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

router.get('/create',  authService.ensureRole(), renderLocationCreateForm);
router.get('/update/:locationId',  authService.ensureRole(), renderLocationUpdateForm);

module.exports = router;
