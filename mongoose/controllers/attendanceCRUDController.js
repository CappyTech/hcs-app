const mdb = require('../../services/mongoose/mongooseDatabaseService');

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
    res.json({attendance});
  }catch(err){ next(err); }
};

exports.readAttendance = async (req,res,next)=>{
  try {
    const attendance = await mdb.attendance.findOne({ uuid: req.params.uuid }).populate('employeeId subcontractorId locationId');
    if(!attendance) {
      req.flash('error', 'Attendance not found.');
      return res.redirect('/attendance');
    }
    res.json({attendance});
  }catch(err){ next(err); }
};

exports.updateAttendance = async (req,res,next)=>{
  try {
    const { date, locationId, projectId, employeeId, subcontractorId, type, hoursWorked, dayRate } = req.body;
    const update = { date, locationId:locationId||null, projectId:projectId||null, employeeId:employeeId||null, subcontractorId:subcontractorId||null, type, hoursWorked:employeeId?hoursWorked||null:null, dayRate:dayRate||null };
    const attendance = await mdb.attendance.findOneAndUpdate({ uuid:req.params.uuid }, update, { new:true });
    if(!attendance) {
      req.flash('error', 'Attendance not found.');
      return res.redirect('/attendance');
    }
    res.json({attendance});
  }catch(err){ next(err); }
};

exports.deleteAttendance = async (req,res,next)=>{
  try {
    await mdb.attendance.findOneAndDelete({ uuid:req.params.uuid });
    res.json({success:true});
  }catch(err){ next(err); }
};
