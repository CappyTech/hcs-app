const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const selectClient = async (req, res, next) => {
    try {
        const clients = await db.Clients.findAll({});
        
        if (clients.length === 0) {
            req.flash('error', 'Error: No Clients exist, Or you don\'t have access to any Clients.');
            res.redirect('/client/create');
        }

        res.render(path.join('clients', 'selectClient'), {
            title: 'Select Client',
            
            
            
            clients,

        });
    } catch (error) {
        logger.error('Error selecting client:  ', error.message);
        req.flash('error', 'Error selecting client: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const renderClientCreateForm = async (req, res, next) => {
    try {
        res.render(path.join('clients', 'createClient'), {
            title: 'Create Client',
            
        });
    } catch (error) {
        logger.error('Error rendering client create form:' + error.message);
        res.status(500).send('Error: ' + error.message);
    }
};

const renderClientUpdateForm = async (req, res, next) => {
    try {
        const clients = await db.Clients.findByPk(req.params.client, {
            include: [{ model: db.Contacts }]
        });

        if (!clients) {
            return res.status(404).send('Client not found');
        }

        res.render(path.join('clients', 'updateClient'), {
            title: 'Update Client',
            clients,
            
        });
    } catch (error) {
        logger.error('Error rendering client update form:' + error.message);
        res.status(500).send('Error: ' + error.message);
    }
};

//router.get('/client/select', selectClient);
router.get('/create',  authService.ensureRoles('admin'), renderClientCreateForm);
router.get('/update/:client',  authService.ensureRoles('admin'), renderClientUpdateForm);

module.exports = router;