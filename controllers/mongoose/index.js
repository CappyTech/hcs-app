const express = require('express');
const fs = require('fs');
const path = require('path');
const authService = require('../../services/mongoose/authServiceMongoose');
const router = express.Router();

const renderIndex = (req, res) => {
    res.render('index', {
        title: 'Home',
    });
};

const renderConstructionIndustryScheme = (req, res) => {
    res.render(path.join('render','construction-industry-scheme'), {
        title: 'Construction Industry Scheme',
    });
};

const renderManagement = (req, res) => {
    res.render(path.join('render','management'), {
        title: 'Management',
    });
};

const renderPayroll = (req, res) => {
    res.render(path.join('render','payroll'), {
        title: 'Payroll',
    });
};

const renderHumanResources = (req, res) => {
    res.render(path.join('render','human-resources'), {
        title: 'Human Resources',
    });
};

const renderKashflow = (req, res) => {
    res.render(path.join('render','kashflow'), {
        title: 'Kashflow',
    });
};

const renderCreate = (req, res) => {
    res.render(path.join('render','create'), {
        title: 'Create',
    });
};

router.get('/', renderIndex);
router.get('/construction-industry-scheme', authService.ensureAuthenticated, renderConstructionIndustryScheme);
router.get('/management', authService.ensureAuthenticated, renderManagement);
router.get('/payroll', authService.ensureAuthenticated, renderPayroll);
router.get('/human-resources', authService.ensureAuthenticated, renderHumanResources);
router.get('/kashflow', authService.ensureAuthenticated, renderKashflow);
router.get('/create', authService.ensureAuthenticated, renderCreate);

module.exports = router;
