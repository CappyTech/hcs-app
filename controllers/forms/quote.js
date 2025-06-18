const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const renderQuoteCreateForm = async (req, res, next) => {
    try {
        

        const clients = await db.Clients.findAll({
            include: [db.Contacts],
            order: [['createdAt', 'DESC']],
        });

        const locations = await db.Locations.findAll({
            order: [['createdAt', 'DESC']],
        });

        return res.render(path.join('quotes', 'createQuote'), {
            title: 'Create Quote',
            clients,
            locations,
            
        });
    } catch (error) {
        logger.error('Error rendering quote create form: ' + error.message);
        req.flash('error', 'Error rendering quotes create form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const renderQuoteUpdateForm = async (req, res, next) => {
    try {
        

        const quote = await db.Quote.findByPk(req.params.quote, {
            include: [{
                model: db.Clients,
                include: [db.Contacts]
            }]
        });

        if (!quote) {
            req.flash('error', 'Quote not found.');
            next(error); // Pass the error to the error handler
        }

        // Fetch all locations to populate the dropdown
        const locations = await db.Locations.findAll({
            order: [['createdAt', 'DESC']],
        });

        return res.render(path.join('quotes', 'updateQuote'), {
            title: 'Update Quote',
            quote,
            locations,
            

        });
    } catch (error) {
        logger.error('Error rendering quote update form:  ', error.message);
        req.flash('error', 'Error rendering quote update form: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

router.get('/create',  authService.ensureRoles('admin'), renderQuoteCreateForm);
router.get('/update/:quote',  authService.ensureRoles('admin'), renderQuoteUpdateForm);

module.exports = router;