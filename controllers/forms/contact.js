const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const selectContact = async (req, res, next) => {
    try {
        
        const contacts = await db.Contacts.findAll({
            include: [{ model: db.Clients, attributes: ['name'] }]
        });

        if (contacts.length === 0) {
            req.flash('error', 'Error: No Contacts exist, or you don\'t have access to any Contacts.');
            return res.redirect('/contact/create');
        }

        const contactList = contacts.map(contact => ({
            id: contact.id,
            name: contact.name,
            clientId: contact.Clients.id,
            clientName: contact.Clients.name
        }));

        res.render(path.join('contacts', 'selectContact'), {
            title: 'Select Contact',
            
            contacts: contactList,

        });
    } catch (error) {
        logger.error('Error selecting contact:   ' + error.message);
        req.flash('error', 'Error selecting contact: ' + error.message);
        next(error); // Pass the error to the error handler
    }
};

const renderContactCreateForm = async (req, res, next) => {
    try {
        

        // Find the client by primary key (PK)
        const clients = await db.Clients.findAll();

        if (!clients) {
            // If the client is not found, send an error message
            req.flash('error', 'Client not found.');
            return res.redirect('/dashboard/client');
        }

        // Render the create contact form and pass the found client to the view
        res.render(path.join('contacts', 'createContact'), {
            title: 'Create Contact',
            clients, // Pass the specific client to the view
            
        });
    } catch (error) {
        logger.error('Error rendering contact create form: ' + error.message);
        res.status(500).send('Error: ' + error.message);
    }
};


const renderContactUpdateForm = async (req, res, next) => {
    try {
        
        const contact = await db.Contacts.findByPk(req.params.contact, {
            include: [{ model: db.Clients }]
        });

        if (!contact) {
            return res.status(404).send('Contact not found');
        }

        res.render(path.join('contacts', 'updateContact'), {
            title: 'Update Contact',
            contact,
            clients: contact.Clients,
            
        });
    } catch (error) {
        logger.error('Error rendering contact update form:' + error.message);
        return res.status(500).send('Error: ' + error.message);
    }
};

//router.get('/contact/select', selectContact);
router.get('/create',  authService.ensureRole(), renderContactCreateForm);
router.get('/update/:contact',  authService.ensureRole(), renderContactUpdateForm);

module.exports = router;