const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const createContact = async (req, res, next) => {
    try {
        const {
            name,
            phone,
            email,
            note
        } = req.body;

        const clientId = req.params.client;
        if (!clientId) {
            req.flash('erorr', 'Client wasn\'t specificied.');
            next(error); // Pass the error to the error handler
        } else {
            const contact = await db.Contacts.create({
                clientId:clientId,
                name:name,
                phone:phone,
                email:email,
                note:note,
            });
            req.flash('success', 'Contact created successfully');
            return res.redirect(`/client/read/${contact.clientId}`);
        }
    } catch (error) {
        if (error.name === 'SequelizeValidationError') {
            const errorMessages = error.errors.map((error) => error.message);
            logger.error(`Validation errors: ${errorMessages.join(', ')}`);
        }
        logger.error('Error creating contact:' + error.message);
        req.flash('error', 'Error: ' + error.message);
        return res.redirect('/dashboard/client');
    }
};

const readContact = async (req, res, next) => {
    try {
        const contact = await db.Contacts.findByPk(req.params.contact, {
            include: [
                { model: db.Clients }
            ]
        });
        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        res.render(path.join('contacts', 'viewContact'), {
            title: 'Contact',
            contact,
        });
    } catch (error) {
        logger.error('Error viewing contact:'+ error.message);
        req.flash('error', 'Error viewing contact:' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const readContacts = async (req, res, next) => {
    try {
        const clients = await db.Clients.findByPk(req.params.client);
        const contacts = await db.Contacts.findAll({
            where: { clientId: req.params.client },
            order: [['name', 'ASC']]
        });
        if (!contacts) {
            return res.status(404).json({ error: 'Contacts not found' });
        }
        res.render(path.join('contacts', 'viewContacts'), {
            title: 'Contacts',
            clients,
            contacts,
        });
    } catch (error) {
        logger.error('Error viewing contacts: ' + error.message);
        req.flash('error', 'Error viewing contacts: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const updateContact = async (req, res, next) => {
    try {
        const { name, phone, email, note } = req.body;
        const contact = await db.Contacts.findByPk(req.params.contact);
        if (!contact) {
            return res.status(404).send('Contact not found');
        }
        contact.name = name;
        contact.phone = phone;
        contact.email = email;
        contact.note = note;

        await contact.save();

        req.flash('success', 'Contact updated successfully');
        return res.redirect(`/client/read/${contact.clientId}`);
    } catch (error) {
        logger.error('Error updating contact: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        return res.redirect(`/client/read/${req.params.client}`);
    }
};

const deleteContact = async (req, res, next) => {
    try {
        const contact = await db.Contacts.findByPk(req.params.contact);
        if (!contact) {
            return res.status(404).send('Contact not found');
        }
        
        await contact.destroy();

        req.flash('success', 'Contact deleted successfully');
        return res.redirect('/dashboard/client/');
    } catch (error) {
        logger.error('Error deleting contact: ' + error.message);
        req.flash('error', 'Error: ' + error.message);
        return res.redirect(`/dashboard/client`);
    }
};

router.get('/fetch/contact/:clientId', async (req, res, next) => {
    try {
        const contacts = await db.Contacts.findAll({
            where: { clientId: req.params.clientId },
            order: [['createdAt', 'ASC']],
        });

        res.json({ contacts });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch contacts' });
    }
});

router.post('/create/:client',  createContact);
router.get('/read/:contact',  readContact);
router.get('/read/:client',  readContacts);
router.post('/update/:contact',  updateContact);
router.post('/delete/:contact',  deleteContact);

module.exports = router;