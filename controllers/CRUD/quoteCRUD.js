const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const createQuote = async (req, res, next) => {
    try {
        
        const { date, quote_ref, job_ref, locationId, clientId, contactId, value, desc, invoice_no, invoice_date } = req.body;
        logger.info(req.body);

        if (!clientId) {
            req.flash('error', 'Client wasn\'t specified.');
            return res.redirect('/quote/create');
        }

        if (!locationId) {
            req.flash('error', 'Location wasn\'t specified.');
            return res.redirect('/quote/create');
        }

        const locationExists = await db.Locations.findByPk(locationId);
        if (!locationExists) {
            req.flash('error', 'Selected location does not exist.');
            return res.redirect('/quote/create');
        }

        const newQuote = await db.Quotes.create({
            date: date,
            quote_ref: quote_ref,
            job_ref: job_ref,
            locationId: locationId,
            clientId: clientId,
            contactId: contactId,
            value: value,
            desc: desc,
            invoice_no: invoice_no,
            invoice_date: invoice_date
        });

        req.flash('success', 'Quote created successfully');
        res.redirect(`/quote/read/${newQuote.id}`);
    } catch (error) {
        logger.error('Error creating quote:' + error.message);
        req.flash('error', 'Error creating quote: ' + error.message);
        res.redirect('/dashboard/quote');
    }
};



const readQuote = async (req, res, next) => {
    try {
        

        const quote = await db.Quotes.findByPk(req.params.quoteId, {
            include: [
                {
                    model: db.Locations
                },
                {
                    model: db.Clients,
                    include: [db.Contacts]
                }
            ]
        });

        if (!quote) {
            req.flash('error', 'Quote not found.');
            return res.redirect('/dashboard/quote');
        }

        res.render(path.join('quotes', 'viewQuote'), {
            title: 'Quote Details',
            quote,
        });
    } catch (error) {
        logger.error('Error viewing quote: ' + error.message);
        req.flash('error', 'Error viewing quote: ' + error.message);
        res.redirect('/dashboard/quote');
    }
};


const readQuotes = async (req, res, next) => {
    try {
        

        const quotes = await db.Quotes.findAll({
            where: { clientId: req.params.client },
            order: [['date', 'DESC']],
            include: [db.Clients]
        });

        res.render(path.join('quotes', 'viewQuotes'), {
            title: 'Quotes',
            quotes,
        });
    } catch (error) {
        logger.error('Error viewing quotes:' + error.message);
        req.flash('error', 'Error viewing quotes: ' + error.message);
        res.redirect('/dashboard/quote');
    }
};

const updateQuote = async (req, res, next) => {
    try {
        const quote = await db.Quotes.findByPk(req.params.id);
        if (!quote) {
            throw new Error('Quote not found');
        }

        await Quotes.update(req.body, { where: { id: req.params.id } });

        req.flash('success', 'Quote updated successfully');
        return res.redirect(`/quote/read/${req.params.id}`);
    } catch (error) {
        logger.error(`Error updating quote with ID: ${req.params.id}. Details:` + error.message);
        req.flash('error', `Error updating quote with ID: ${req.params.id}. Details:` + error.message);
        return res.redirect(`/quote/read/${req.params.id}`);
    }
};

const deleteQuote = async (req, res, next) => {
    try {
        

        const quote = await db.Quotes.findByPk(req.params.id);

        if (!quote) {
            req.flash('error', 'Quote not found');
            return res.redirect('/dashboard/quote');
        }

        await quote.destroy();

        req.flash('success', 'Quote deleted successfully');
        res.redirect('/dashboard/quote');
    } catch (error) {
        logger.error('Error deleting quote: ' + error.message);
        req.flash('error', 'Error deleting quote: ' + error.message);
        res.redirect('/dashboard/quote');
    }
};

router.get('/fetch/quote/:quoteId', async (req, res, next) => {
    try {
        

        const quotes = await db.Quotes.findAll({
            where: { id: req.params.quoteId },
            order: [['createdAt', 'ASC']],
        });

        res.json({ quotes });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch quotes' });
    }
});


router.post('/create/:client',  authService.ensureRoles('admin'), createQuote);
router.get('/read/:quoteId',  authService.ensureRoles('admin'), readQuote);
router.get('/read/:client',  authService.ensureRoles('admin'), readQuotes);
router.post('/update/:id',  authService.ensureRoles('admin'), updateQuote);
router.post('/delete/:id',  authService.ensureRoles('admin'), deleteQuote);

module.exports = router;
