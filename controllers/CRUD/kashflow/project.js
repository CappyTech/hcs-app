const express = require('express');
const router = express.Router();
const logger = require('../../../services/loggerService');
const path = require('path');
const fs = require('fs');
const db = require('../../../services/kashflowDatabaseService');
const authService = require('../../../services/authService');
const sanitize = require('sanitize-filename');

const projectsDir = path.join(__dirname, '../../../Projects');
if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.chmodSync(projectsDir, 0o700);
}

const readProject = async (req, res, next) => {
    try {
        const Project = await db.KF_Projects.findByPk(req.params.uuid);
        if (!Project) {
            req.flash('error', 'Project not found.');
            return res.redirect('/dashboard/project');
        }

        const projectDir = path.join(projectsDir, Project.Number.toString());
        let files = [];
        if (fs.existsSync(projectDir)) {
            files = fs.readdirSync(projectDir);
        }

        res.render(path.join('kashflow', 'viewProject'), {
            title: 'Job Overview',
            Project,
            files,
        });
    } catch (error) {
        logger.error('Error reading project: ' + error.message);
        req.flash('error', 'An unexpected error occurred.');
        next(error);
    }
};

const serveFile = async (req, res, next) => {
    try {
        const Project = await db.KF_Projects.findByPk(req.params.uuid);
        if (!Project) {
            req.flash('error', 'Project not found.');
            return res.redirect('/dashboard/project');
        }

        const safeFilename = sanitize(req.params.filename);
        const filePath = path.join(projectsDir, Project.Number.toString(), safeFilename);

        if (!fs.existsSync(filePath)) {
            req.flash('error', 'File not found.');
            return res.redirect(`/kashflow/project/read/${req.params.uuid}`);
        }

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.sendFile(filePath);
    } catch (error) {
        logger.error('Error serving file: ' + error.message);
        req.flash('error', 'An unexpected error occurred.');
        next(error);
    }
};

const viewFile = async (req, res, next) => {
    try {
        const Project = await db.KF_Projects.findByPk(req.params.uuid);
        if (!Project) {
            req.flash('error', 'Project not found.');
            return res.redirect('/dashboard/project');
        }

        const safeFilename = sanitize(req.params.filename);
        const filePath = path.join(projectsDir, Project.Number.toString(), safeFilename);
        if (!fs.existsSync(filePath)) {
            req.flash('error', 'File not found.');
            return res.redirect(`/kashflow/project/read/${req.params.uuid}`);
        }

        const ext = path.extname(filePath).toLowerCase();
        let fileType = 'unsupported';
        if (['.jpg', '.jpeg', '.png'].includes(ext)) fileType = 'image';
        if (ext === '.pdf') fileType = 'pdf';

        res.render(path.join('kashflow', 'viewFile'), {
            title: 'View File',
            file: safeFilename,
            filePath: `/kashflow/project/${req.params.uuid}/serve/${encodeURIComponent(safeFilename)}`,
            fileType,
            uuid: req.params.uuid,
        });
    } catch (error) {
        logger.error('Error viewing file: ' + error.message);
        req.flash('error', 'An unexpected error occurred.');
        next(error);
    }
};

router.get('/project/read/:uuid',  authService.ensureRole(), readProject);
router.get('/project/:uuid/serve/:filename',  authService.ensureRole(), serveFile);
router.get('/project/:uuid/view/:filename',  authService.ensureRole(), viewFile);


module.exports = router;