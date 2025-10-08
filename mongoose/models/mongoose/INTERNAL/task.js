const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const taskSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  dueDate: { type: Date },
  recurrence: { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true, index: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'job', default: null },
  completed: { type: Boolean, default: false, index: true }
}, {
  timestamps: true
});

// Validation: if recurrence is not 'none', a dueDate must exist.
taskSchema.pre('validate', function(next) {
  if (this.recurrence && this.recurrence !== 'none' && !this.dueDate) {
    return next(new Error('Recurring tasks must have a dueDate.'));
  }
  next();
});

// Helpful compound index to accelerate dashboard categorisation queries.
// Not unique to avoid migration issues with legacy duplicates.
taskSchema.index({ userId: 1, completed: 1, dueDate: 1 });


module.exports = {
  modelName: 'task',
  schema: taskSchema
};
