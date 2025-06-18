const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

exports.createAttendance = async (req,res,next)=>{
  try {
    const { date, locationId, projectId, employeeId, subcontractorId, type, hoursWorked, dayRate } = req.body;
    if(locationId && projectId)  {
      req.flash('error', 'Location or project only.');
      return res.redirect('/attendance/create');
    }
    if(!locationId && !projectId)  {
      req.flash('error', 'Location or project only.');
      return res.redirect('/attendance/create');
    };
    
    if(hoursWorked && dayRate) {
      req.flash('error', 'Hours or dayRate only.');
      return res.redirect('/attendance/create');
    }
    const attendance = await mdb.attendance.create({ date, locationId:locationId||null, projectId:projectId||null, employeeId:employeeId||null, subcontractorId:subcontractorId||null, type, hoursWorked:hoursWorked||null, dayRate:dayRate||null });
    req.flash('success', 'Attendance created successfully.');
    res.redirect('/dashboard/attendance');
  }catch(err){ next(err); }
};

exports.readAttendance = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    let attendance = await mdb.attendance.findOne({ uuid: identifier }).populate('employeeId subcontractorId locationId');
    if(!attendance && mongoose.Types.ObjectId.isValid(identifier)) {
      attendance = await mdb.attendance.findById(identifier).populate('employeeId subcontractorId locationId');
    }
    if(!attendance) {
      req.flash('error', 'Attendance not found.');
      return res.redirect('/attendance');
    }
    res.render(path.join('attendance','viewAttendance'), {
      title: 'Attendance Details',
      attendance
    });
  }catch(err){ next(err); }
};

exports.updateAttendance = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    const { date, locationId, projectId, employeeId, subcontractorId, type, hoursWorked, dayRate } = req.body;
    const update = { date, locationId:locationId||null, projectId:projectId||null, employeeId:employeeId||null, subcontractorId:subcontractorId||null, type, hoursWorked:employeeId?hoursWorked||null:null, dayRate:dayRate||null };
    const query = mongoose.Types.ObjectId.isValid(identifier)
      ? { $or: [{ uuid: identifier }, { _id: identifier }] }
      : { uuid: identifier };
    const attendance = await mdb.attendance.findOneAndUpdate(query, update, { new:true });
    if(!attendance) {
      req.flash('error', 'Attendance not found.');
      return res.redirect('/attendance');
    }
    req.flash('success', 'Attendance updated successfully.');
    res.redirect('/dashboard/attendance');
  }catch(err){ next(err); }
};

exports.deleteAttendance = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(identifier)
      ? { $or: [{ uuid: identifier }, { _id: identifier }] }
      : { uuid: identifier };
    await mdb.attendance.findOneAndDelete(query);
    req.flash('success', 'Attendance deleted successfully.');
    res.redirect('/dashboard/attendance');
  }catch(err){ next(err); }
};
