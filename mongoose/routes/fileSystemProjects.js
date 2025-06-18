const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const authService = require('../../services/authService');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

const projectsDir = path.join(__dirname, '../../Projects');
if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.chmodSync(projectsDir, 0o700);
}

const createProjectDirectory = async (project) => {
    const projectDir = path.join(projectsDir, project.Number.toString());
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
        fs.chmodSync(projectDir, 0o700);
    }
};

const createDirectoriesForProjects = async () => {
    const projects = await mdb.project.find();
    for (const project of projects) {
        await createProjectDirectory(project);
    }
};

createDirectoriesForProjects();

const upload = multer({
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
        const mimeType = allowedTypes.test(file.mimetype);
        const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());

        if (mimeType && extName) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, PDF, DOC, and DOCX files are allowed.'));
        }
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

router.post('/project/:uuid/:number/upload', authService.ensureRole(), upload.array('files', 10), (req, res) => {
    const projectDir = path.join(projectsDir, req.params.number.toString());
    req.files.forEach(file => {
        const sanitizedFileName = sanitize(file.originalname);
        const filePath = path.join(projectDir, sanitizedFileName);
        fs.renameSync(file.path, filePath);
    });
    res.redirect(`/project/read/${req.params.uuid}`);
});

router.get('/project/:uuid/:number/download/:filename', authService.ensureRole(), (req, res) => {
    const sanitizedFileName = sanitize(req.params.filename);
    const filePath = path.join(projectsDir, req.params.number.toString(), sanitizedFileName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found.');
    }

    res.download(filePath, (err) => {
        if (err) {
            logger.error(`Download error: ${err.message}`);
            return res.status(500).send('Failed to download file.');
        } else {
            logger.info('Download successful.');
        }
    });
});

module.exports = router;
