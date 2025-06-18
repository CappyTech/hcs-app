const express = require('express');
const router = express.Router();
const logger = require('../../services/loggerService');
const db = require('../../services/sequelizeDatabaseService');
const authService = require('../../services/authService');

router.get('/fetch/user/:id',  authService.ensureRoles('admin'), async (req, res, next) => {
    try {
        const user = await db.Users.findAll({
            where: { id: req.params.id },
            order: [['createdAt', 'ASC']],
        });

        res.json({ user });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

module.exports = router;