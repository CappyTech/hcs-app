const path = require('path');

exports.renderIndex = async (req, res, next) => {
    try {
        let tasks = [];
        if (req.user) {
            const taskService = require('../services/taskService');
            tasks = await taskService.getPendingTasksForUser(req.user._id);
        }
        res.render(path.join('mongoose','index'), {
            title: 'Home',
            tasks
        });
    } catch (err) {
        next(err);
    }
};

exports.renderConstructionIndustryScheme = (req, res, next) => {
    res.render(path.join('mongoose', 'header', 'construction-industry-scheme'), {
        title: 'Construction Industry Scheme',
    });
};

exports.renderManagement = (req, res, next) => {
    res.render(path.join('mongoose', 'header', 'management'), {
        title: 'Management',
    });
};

exports.renderPayroll = (req, res, next) => {
    res.render(path.join('mongoose', 'header', 'payroll'), {
        title: 'Payroll',
    });
};

exports.renderHumanResources = (req, res, next) => {
    res.render(path.join('mongoose', 'header', 'human-resources'), {
        title: 'Human Resources',
    });
};

exports.renderKashflow = (req, res, next) => {
    res.render(path.join('mongoose', 'header', 'kashflow'), {
        title: 'Kashflow',
    });
};

exports.renderCreate = (req, res, next) => {
    res.render(path.join('mongoose', 'header', 'create'), {
        title: 'Create',
    });
};
