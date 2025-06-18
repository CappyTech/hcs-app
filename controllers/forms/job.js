const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const renderJobCreateForm = async (req, res, next) => {
    try {
        

        const clients = await db.Clients.findAll({
            include: [db.Quotes],
            order: [['createdAt', 'DESC']],
        });

        if (!clients || clients.length === 0) {
            req.flash('error', 'Error: No Clients exist.');
            return res.redirect('/client/create');
        }

        const locations = await Locations.findAll({
            order: [['createdAt', 'DESC']],
        });

        return res.render(path.join('jobs', 'createJob'), {
            title: 'Create Job',
            clients,
            locations,
            
        });
    } catch (error) {
        logger.error('Error rendering job create form: ' + error.message);
        req.flash('error', 'Error rendering job create form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const renderJobUpdateForm = async (req, res, next) => {
    try {
        
        const job = await db.Jobs.findByPk(req.params.jobId, {
            include: [db.Clients, db.Locations, db.Quotes],
        });

        if (!job) {
            req.flash('error', 'Job not found.');
            return res.redirect('/dashboard/job');
        }

        res.render(path.join('jobs', 'updateJob'), {
            title: 'Update Job',
            job,
            
        });
    } catch (error) {
        req.flash('error', 'Error loading the job update form: ' + error.message);
        return res.redirect('/dashboard/job');
    }
};

router.get('/create',  authService.ensureRole(), renderJobCreateForm);
router.get('/update/:jobId',  authService.ensureRole(), renderJobUpdateForm);

module.exports = router;
