const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../services/loggerService')

const attendanceSchema = new mongoose.Schema({
    uuid: { type: String, unique: true, required: true, default: uuidv4 },
    date: { type: Date, required: true },
    type: {
        type: String,
        enum: ['off', 'holiday', 'sick', 'work', 'training', 'leave'],
        default: 'work'
    },
    locationId: { type: mongoose.Schema.Types.ObjectId, ref: 'location' },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'project' },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'employee' },
    subcontractorId: { type: mongoose.Schema.Types.ObjectId, ref: 'supplier' },
    hoursWorked: { type: mongoose.Decimal128, min: 0 },
    payRate: { type: mongoose.Decimal128, min: 0 },
    dayRate: { type: mongoose.Decimal128, min: 0 },
    contractAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'assignment' },
}, {
    timestamps: true
});

attendanceSchema.pre('validate', function (next) {
    logger.debug('employeeId:', this.employeeId);
    logger.debug('subcontractorId:', this.subcontractorId);

    if ((this.employeeId && this.subcontractorId) || (!this.employeeId && !this.subcontractorId)) {
        return next(new Error('Attendance must reference either employee or subcontractor, not both or neither.'));
    }
    if (this.hoursWorked && this.dayRate) {
        return next(new Error('Attendance should have hoursWorked or dayRate, not both.'));
    }
    if ((this.locationId && this.projectId) || (!this.locationId && !this.projectId)) {
        return next(new Error('Attendance must have either a locationId or a projectId, not both or neither.'));
    }
    next();
});

module.exports = mongoose.model('attendance', attendanceSchema);