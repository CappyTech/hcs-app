const express = require('express');
const router = express.Router();
const logger = require('../../../services/loggerService');
const path = require('path');
const db = require('../../../services/kashflowDatabaseService');
const authService = require('../../../services/authService');

const readQuote = async (req, res, next) => {
    try {
        const Quote = await db.KF_Quotes.findByPk(req.params.uuid, {
            include: [
                {
                    model: db.KF_Customers,
                    as: 'customer',
                    attributes: ['uuid', 'Name'],
                }
            ]
        });

        if (!Quote) {
            req.flash('error', 'Quote not found.');
            return res.redirect('/dashboard/KFquote');
        }

        // Parse Lines if stored as a JSON string
        Quote.Lines = typeof Quote.Lines === 'string' ? JSON.parse(Quote.Lines) : Quote.Lines || [];

        res.render(path.join('kashflow', 'viewQuote'), {
            title: 'Quote Overview',
            Quote,
            Customer: Quote.customer, // Pass customer data to EJS
        });
    } catch (error) {
        logger.error('Error reading kashflow Quote: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error);
    }
};


router.get('/quote/read/:uuid',  authService.ensureRole(), readQuote);

module.exports = router;