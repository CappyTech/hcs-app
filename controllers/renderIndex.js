const express = require('express');
const fs = require('fs');
const path = require('path');
const authService = require('../services/sequelize/authService');
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
router.get('/construction-industry-scheme', renderConstructionIndustryScheme);
router.get('/management', renderManagement);
router.get('/payroll', renderPayroll);
router.get('/human-resources', renderHumanResources);
router.get('/kashflow', renderKashflow);
router.get('/create', renderCreate);

module.exports = router;
