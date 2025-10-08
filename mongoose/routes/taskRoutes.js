const express = require('express');
const router = express.Router();
const taskService = require('../services/taskServiceMongoose');
const authService = require('../../services/authService');

// GET /tasks - list pending tasks for current user
router.get('/tasks', authService.ensureAuthenticated, authService.ensureRole(), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).send('Not authenticated');
    const tasks = await taskService.getPendingTasksForUser(req.user._id);
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
