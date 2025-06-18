const path = require('path');
const taskService = require('../services/taskService');

exports.renderCreateTaskForm = (req, res) => {
  res.render(path.join('mongoose', 'createTask'), {
    title: 'Create Task'
  });
};

exports.createTask = async (req, res, next) => {
  try {
    const { title, description, dueDate, recurrence } = req.body;
    const userId = req.user._id;
    await taskService.createTask({
      title,
      description,
      userId,
      dueDate: dueDate || null,
      recurrence: recurrence || 'none'
    });
    req.flash('success', 'Task created');
    res.redirect('/');
  } catch (err) {
    next(err);
  }
};
