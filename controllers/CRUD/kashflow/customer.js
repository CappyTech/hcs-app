const express = require('express');
const router = express.Router();
const logger = require('../../../services/loggerService');
const path = require('path');
const db = require('../../../services/kashflowDatabaseService');
const authService = require('../../../services/authService');

const readCustomer = async (req, res, next) => {
    try {
        const Customer = await db.KF_Customers.findByPk(req.params.uuid, {
            include: [
                {
                    model: db.KF_Invoices,
                    as: 'invoices',
                    attributes: ['uuid', 'InvoiceNumber', 'InvoiceDate', 'DueDate', 'NetAmount'],
                },
                {
                    model: db.KF_Quotes,
                    as: 'quotes',
                    attributes: ['uuid', 'InvoiceNumber', 'InvoiceDate', 'NetAmount'],
                },
                {
                    model: db.KF_Projects,
                    as: 'projects',
                    attributes: ['uuid', 'CustomerID', 'Name'],
                }
            ]
        });

        if (!Customer) {
            req.flash('error', 'Customer not found.');
            return res.redirect('/dashboard/KFcustomer');
        }

        res.render(path.join('kashflow', 'viewCustomer'), {
            title: 'Customer Overview',
            Customer,
        });
    } catch (error) {
        logger.error('Error reading kashflow customer: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error);
    }
};


router.get('/customer/read/:uuid',  authService.ensureRoles('admin'), readCustomer);

module.exports = router;