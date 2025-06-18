const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

// Create a new location
const createLocation = async (req, res, next) => {
    try {
        
        const {name, address, city, postalCode, country, latitude, longitude } = req.body;

        const newLocation = await db.Locations.create({
            name,
            address,
            city,
            postalCode,
            country,
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
        });

        req.flash('success', 'Location created successfully.');
        res.redirect(`/dashboard/location`);
    } catch (error) {
        logger.error('Error creating location: ' + error.message);
        req.flash('error', 'Error creating location: ' + error.message);
        res.redirect('/location/create');
    }
};


// Read a specific location
const readLocation = async (req, res, next) => {
    try {
        
        const location = await db.Locations.findByPk(req.params.id);

        if (!location) {
            req.flash('error', 'Location not found.');
            return res.redirect('/dashboard/location');
        }

        res.render(path.join('locations', 'viewLocation'), {
            title: 'View Location',
            location,  
        });
    } catch (error) {
        logger.error('Error viewing location: ' + error.message);
        req.flash('error', 'Error viewing location: ' + error.message);
        res.redirect('/dashboard/location');
    }
};

// Update an existing location
const updateLocation = async (req, res, next) => {
    try {
        
        const { name, address, city, postalCode, country, latitude, longitude } = req.body;

        const location = await db.Locations.findByPk(req.params.id);
        if (!location) {
            req.flash('error', 'Location not found.');
            return res.redirect('/dashboard/location');
        }

        location.name = name;
        location.address = address;
        location.city = city;
        location.postalCode = postalCode;
        location.country = country;
        location.latitude = parseFloat(latitude);
        location.longitude = parseFloat(longitude);

        await location.save();

        req.flash('success', 'Location updated successfully.');
        res.redirect(`/location/read/${location.id}`);
    } catch (error) {
        logger.error('Error updating location: ' + error.message);
        req.flash('error', 'Error updating location: ' + error.message);
        res.redirect(`/location/update/${req.params.locationId}`);
    }
};


// Delete a location
const deleteLocation = async (req, res, next) => {
    try {
        
        const location = await db.Locations.findByPk(req.params.id);

        if (!location) {
            req.flash('error', 'Location not found.');
            return res.redirect('/dashboard/location');
        }

        await location.destroy();

        req.flash('success', 'Location deleted successfully.');
        res.redirect('/dashboard/location');
    } catch (error) {
        logger.error('Error deleting location: ' + error.message);
        req.flash('error', 'Error deleting location: ' + error.message);
        res.redirect('/dashboard/location');
    }
};

router.get('/fetch/location/:id', async (req, res, next) => {
    try {
        

        const location = await db.Locations.findAll({
            where: { id: req.params.id },
            order: [['createdAt', 'ASC']],
        });

        res.json({ location });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch location' });
    }
});

// Define routes
router.post('/create',  authService.ensureRoles('admin'), createLocation);
router.get('/read/:id',  authService.ensureRoles('admin'), readLocation);
router.post('/update/:id',  authService.ensureRoles('admin'), updateLocation);
router.post('/delete/:id',  authService.ensureRoles('admin'), deleteLocation);

module.exports = router;
