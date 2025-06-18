const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService'); 
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const createSubcontractor = async (req, res, next, error) => {
    try {
        const {
            name,
            company,
            line1,
            line2,
            city,
            county,
            postalCode,
            cisNumber,
            utrNumber,
            vatNumber,
            deduction,
            isGross
        } = req.body;

        // Check if the subcontractor already exists
        const existingSubcontractor = await db.Subcontractors.findOne({
            where: {
                [db.Sequelize.Op.or]: [{ utrNumber }],
            },
        });

        if (existingSubcontractor) {
            req.flash('error', 'User with the same UTR already exists.');
            logger.error('User with the same UTR already exists.')
            return res.redirect('/subcontractor/create'); // Redirect to the appropriate page
        }

        const requiredFields = [company, utrNumber];
        if (requiredFields.some(field => !field)) {
            req.flash('error', 'Incomplete required form data.');
            logger.error('Incomplete required form data.')
            return res.redirect('/subcontractor/create');
        }

        // Null checks for specific fields
        const nullCheckFields = ['company', 'utrNumber', 'vatNumber'];
        const sanitizedData = Object.fromEntries(
            Object.entries(req.body).map(([key, value]) => [
                key,
                nullCheckFields.includes(key) ? (value || null) : value,
            ])
        );
        logger.info('Data to be inserted: ' +  JSON.stringify(sanitizedData, null, 2));
        await db.Subcontractors.create(sanitizedData);

        req.flash('success', 'Subcontractor created.');
        logger.info('Subcontractor created.')
        const referer = '/dashboard/subcontractor';
        res.redirect(referer);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            logger.error('Unique constraint error: '+ error);
            req.flash('error', 'A subcontractor with this UTR, or VAT number already exists.');
            return res.redirect('/subcontractor/create');
        }
        logger.error('Error creating subcontractor: ' + error.message);
        req.flash('error', 'Error creating subcontractor: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const readSubcontractor = async (req, res, next) => {
    try {
        const subcontractor = await db.Subcontractors.findByPk(req.params.id);

        if (!subcontractor) {
            return res.status(404).send('Subcontractor not found');
        }

        res.render(path.join('subcontractors', 'viewSubcontractor'), {
            title: 'Subcontractor',
            subcontractor,
        });
    } catch (error) {
        logger.error('Error reading subcontractor: ' + error.message);
        req.flash('error', 'Error reading subcontractor: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const updateSubcontractor = async (req, res, next, error) => {
    try {
        // Extract data from the request body
        const {
            name,
            company,
            line1,
            line2,
            city,
            county,
            postalCode,
            cisNumber,
            utrNumber,
            vatNumber,
            deduction,
            isGross,
            isReverseCharge
        } = req.body;

        // Find the subcontractor by ID
        const subcontractor = await db.Subcontractors.findByPk(req.params.id);

        // If subcontractor is not found
        if (!subcontractor) {
            req.flash('error', 'Subcontractor not found.');
            logger.warn('Subcontractor not found.');
            return res.redirect('/dashboard/subcontractor');
        }

        // Check for unique utrNumber only if it's provided and different from the existing one
        if (utrNumber && subcontractor.utrNumber !== utrNumber) {
            const existingUtr = await db.Subcontractors.findOne({
                where: { utrNumber, id: { [db.Sequelize.Op.ne]: req.params.id } }
            });
            if (existingUtr) {
                req.flash('error', 'A subcontractor with this UTR number already exists.');
                return res.redirect('/subcontractor/update/' + req.params.id);
            }
        }

        // Check for unique vatNumber only if it's provided and different from the existing one
        if (vatNumber && subcontractor.vatNumber !== vatNumber) {
            const existingVat = await db.Subcontractors.findOne({
                where: { vatNumber, id: { [db.Sequelize.Op.ne]: req.params.id } }
            });
            if (existingVat) {
                req.flash('error', 'A subcontractor with this VAT number already exists.');
                return res.redirect('/subcontractor/update/' + req.params.id);
            }
        }

        // Prepare updated data with null values for empty or undefined fields
        const updatedData = {
            name: name || null,
            company: company || null,
            line1: line1 || null,
            line2: line2 || null,
            city: city || null,
            county: county || null,
            postalCode: postalCode || null,
            cisNumber: cisNumber || null,
            utrNumber: utrNumber || null,
            vatNumber: vatNumber || null,
            deduction: deduction || null,
            isGross: isGross || false,
            isReverseCharge: isReverseCharge || false
        };

        // Update subcontractor with sanitized data
        await db.Subcontractors.update(updatedData, { where: { id: req.params.id } });

        // Flash success message and redirect
        req.flash('success', 'Subcontractor updated successfully.');
        logger.info('Subcontractor updated successfully.');
        return res.redirect('/dashboard/subcontractor');

    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            logger.error('Unique constraint error: ', error);
            req.flash('error', 'A subcontractor with this UTR or VAT number already exists.');
            next(error); // Pass the error to the error handler
        }
        logger.error('Error updating subcontractor: ' + error.message);
        req.flash('error', 'Error updating subcontractor: ' + error.message);
        return res.redirect('/dashboard/subcontractor');
    }
};




const deleteSubcontractor = async (req, res, next, error) => {
    try {

        const subcontractor = await db.Subcontractors.findByPk(req.params.id);

        if (!subcontractor) {
            req.flash('error', 'Subcontractor not found');
            logger.warn('Subcontractor not found.');
            return res.redirect('/dashboard/subcontractor');
        }

        await subcontractor.destroy();

        req.flash('success', 'Subcontractor deleted.');
        logger.info('Subcontractor deleted.');
        res.redirect('/dashboard/subcontractor');
    } catch (error) {
        logger.error('Error deleting subcontractor:  ', error.message);
        req.flash('error', 'Error deleting subcontractor: ' + error.message);
        res.redirect('/dashboard/subcontractor');
    }
};

router.get('/fetch/subcontractor/:id',  authService.ensureRoles('admin'), async (req, res, next) => {
    try {
        const subcontractor = await db.Subcontractors.findAll({
            where: { id: req.params.id },
            order: [['createdAt', 'ASC']],
            include: [
                {
                    model: db.Invoices,
                    as: 'invoices',
                    limit: 1,
                    order: [['createdAt', 'DESC']],
                },
            ],
        });

        if (!subcontractor) {
            return res.status(404).json({ error: 'Subcontractor not found' });
        }

        // Get the most recent invoice number
        const mostRecentInvoice = subcontractor.invoices.length > 0 ? subcontractor.invoices[0] : null;


        res.json({
            subcontractor: subcontractor,
            mostRecentInvoiceNumber: mostRecentInvoice ? mostRecentInvoice.invoiceNumber : null,
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch subcontractor' });
    }
});

router.post('/create',  authService.ensureRoles('admin'), createSubcontractor);
router.get('/read/:id',  authService.ensureRoles('admin'), readSubcontractor);
router.post('/update/:id',  authService.ensureRoles('admin'), updateSubcontractor);
router.post('/delete/:id',  authService.ensureRoles('admin'), deleteSubcontractor);

module.exports = router;
