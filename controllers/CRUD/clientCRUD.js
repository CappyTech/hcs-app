const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const createClient = async (req, res, next) => {
    try {
        

        const {
            name 
        } = req.body;

        const clients = await db.Clients.create({
            name: name
        });

        req.flash('success', 'Client created successfully');
        return res.redirect(`/client/read/${clients.id}`);
        
    } catch (error) {
        logger.error('Error creating client:' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const readClient = async (req, res, next) => {
    try {
        

        const clientId = req.params.clientId;

        const clients = await db.Clients.findByPk(clientId, {
            include: [
                {
                    model: db.Contacts,
                },
                {
                    model: db.Quotes,
                    include: [db.Locations],
                },
                {
                    model: db.Jobs,
                    include: [db.Locations],
                },
            ],
        });

        if (!clients) {
            req.flash('error', 'Client not found.');
            return res.redirect('/dashboard/client');
        }

        res.render(path.join('clients', 'viewClient'), {
            title: 'Client Overview',
            clients,
        });
    } catch (error) {
        logger.error('Error fetching client overview: ' + error.message);
        req.flash('error', 'Error fetching client overview: ' + error.message);
        res.redirect('/dashboard/client');
    }
};

const updateClient = async (req, res, next) => {
    try {
        const clients = await db.Clients.findByPk(req.params.clientId);

        if (!clients) {
            return res.status(404).send('Client not found');
        }

        await clients.update(req.body);
        req.flash('success', 'Client updated successfully');
        return res.redirect(`/client/read/${clients.clientId}`);
    } catch (error) {
        logger.error('Error updating client:' + error.message);
        req.flash('error', 'Error: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const deleteClient = async (req, res, next) => {
    try {
        const clients = await db.Clients.findByPk(req.params.clientId);

        if (!clients) {
            return res.status(404).send('Client not found');
        }

        await clients.destroy();
        req.flash('success', 'Client deleted successfully');
        res.redirect('/dashboard/client');
    } catch (error) {
        logger.error('Error deleting client:' + error.message);
        req.flash('error', 'Error: ' + error.message);
        return res.redirect(req.get('referer') || '/');
    }
};

router.get('/fetch/:clientId', async (req, res, next) => {
    try {
        

        const clients = await db.Clients.findAll({
            where: { id: req.params.clientId },
            order: [['createdAt', 'ASC']],
        });

        res.json({ clients });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch clients' });
    }
});

router.post('/create',  authService.ensureRoles('admin'), createClient);
router.get('/read/:clientId',  authService.ensureRoles('admin'), readClient);
router.post('/update/:clientId',  authService.ensureRoles('admin'), updateClient);
router.post('/delete/:clientId',  authService.ensureRoles('admin'), deleteClient);

module.exports = router;