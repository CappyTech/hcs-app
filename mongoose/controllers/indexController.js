const path = require('path');

exports.renderIndex = (req, res) => {
    res.render('index', {
        title: 'Home',
    });
};

exports.renderConstructionIndustryScheme = (req, res) => {
    res.render(path.join('render','construction-industry-scheme'), {
        title: 'Construction Industry Scheme',
    });
};

exports.renderManagement = (req, res) => {
    res.render(path.join('render','management'), {
        title: 'Management',
    });
};

exports.renderPayroll = (req, res) => {
    res.render(path.join('render','payroll'), {
        title: 'Payroll',
    });
};

exports.renderHumanResources = (req, res) => {
    res.render(path.join('render','human-resources'), {
        title: 'Human Resources',
    });
};

exports.renderKashflow = (req, res) => {
    res.render(path.join('render','kashflow'), {
        title: 'Kashflow',
    });
};

exports.renderCreate = (req, res) => {
    res.render(path.join('render','create'), {
        title: 'Create',
    });
};
