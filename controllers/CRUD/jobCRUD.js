const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const path = require('path');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

const createJob = async (req, res, next) => {
    try {
        
        const quote = await db.Quotes.findByPk(req.params.quoteId, {
            include: [Clients]
        });

        if (!quote) {
            req.flash('error', 'Quote not found');
            return res.redirect('/dashboard/quote');
        }

        const job = await db.Jobs.create({
            job_ref: `JOB-${quote.quote_ref}`,
            locationId: quote.locationId,
            clientId: quote.clientId,
            quoteId: quote.id,
            value: quote.value,
            desc: quote.desc,
            status: 'pending',
        });

        quote.isAccepted = true;
        await quote.save();

        req.flash('success', 'Quote successfully converted to Job.');
        return res.redirect(`/job/read/${job.id}`);
    } catch (error) {
        logger.error('Error converting quote to job: ' + error.message);
        req.flash('error', 'Error converting quote to job: ' + error.message);
        return res.redirect('/dashboard/quote');
    }
};

const readJob = async (req, res, next) => {
    try {
        
        const job = await db.Jobs.findByPk(req.params.jobId, {
            include: [db.Clients, db.Quotes, db.Locations]
        });

        if (!job) {
            req.flash('error', 'Job not found');
            return res.redirect('/dashboard/job');
        }

        res.render(path.join('jobs', 'viewJob'), {
            title: 'Job',
            job,
        });
    } catch (error) {
        logger.error('Error reading job: ' + error.message);
        req.flash('error', 'Error reading job: ' + error.message);
        return res.redirect('/dashboard/job');
    }
};

const updateJob = async (req, res, next) => {
    try {
        
        const job = await db.Jobs.findByPk(req.params.jobId);

        if (!job) {
            req.flash('error', 'Job not found');
            return res.redirect('/dashboard/job');
        }

        await Jobs.update(req.body, { where: { id: req.params.jobId } });

        req.flash('success', 'Job updated successfully');
        return res.redirect(`/job/read/${req.params.jobId}`);
    } catch (error) {
        logger.error('Error updating job: ' + error.message);
        req.flash('error', 'Error updating job: ' + error.message);
        return res.redirect(`/job/read/${req.params.jobId}`);
    }
};

const deleteJob = async (req, res, next) => {
    try {
        
        const job = await db.Jobs.findByPk(req.params.jobId);

        if (!job) {
            req.flash('error', 'Job not found');
            return res.redirect('/dashboard/job');
        }

        await job.destroy();

        req.flash('success', 'Job deleted successfully');
        return res.redirect('/dashboard/job');
    } catch (error) {
        logger.error('Error deleting job: ' + error.message);
        req.flash('error', 'Error deleting job: ' + error.message);
        return res.redirect('/dashboard/job');
    }
};

router.get('/fetch/job/:id', async (req, res, next) => {
    try {
        

        const job = await db.Jobs.findAll({
            where: { id: req.params.id },
            order: [['createdAt', 'ASC']],
        });

        res.json({ job });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch job' });
    }
});

router.get('/create/:quoteId',  authService.ensureRoles('admin'), createJob);
router.get('/read/:jobId',  authService.ensureRoles('admin'), readJob);
router.post('/update/:jobId',  authService.ensureRoles('admin'), updateJob);
router.post('/delete/:jobId',  authService.ensureRoles('admin'), deleteJob);

module.exports = router;
