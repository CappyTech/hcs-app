const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const taskSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: uuidv4 },
  title: { type: String, required: true },
  description: { type: String },
  dueDate: { type: Date },
  recurrence: { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'job', default: null },
  completed: { type: Boolean, default: false }
}, {
  timestamps: true
});

module.exports = {
  modelName: 'task',
  schema: taskSchema
};
