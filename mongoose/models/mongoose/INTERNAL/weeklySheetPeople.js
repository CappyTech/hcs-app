import mongoose from 'mongoose';
import crypto from 'crypto';

// Who's on the weekly sheet, as changed by hand, from a week onwards.
//
// The sheet's rows start from everyone active (employees) and subcontractors
// with attendance in the last few weeks. Adding someone (a former employee,
// another subcontractor) or removing someone is stored for that week as the
// full set of changes in force, and a week with no document of its own uses
// the nearest earlier one: so each week starts with the people of the week
// before. Anyone with attendance in a week is always shown that week.
//
// People are personKeys: 'e:<employee _id>' or 's:<supplier _id>'.
const weeklySheetPeopleSchema = new mongoose.Schema({
  uuid: { type: String, unique: true, required: true, default: () => crypto.randomUUID() },
  // The week's Monday, yyyy-mm-dd
  monday: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  added: { type: [String], default: [] },
  removed: { type: [String], default: [] },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user' },
}, { timestamps: true });

export default {
  modelName: 'weeklySheetPeople',
  schema: weeklySheetPeopleSchema,
};
