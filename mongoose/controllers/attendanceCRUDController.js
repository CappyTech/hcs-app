const mdb = require('../../services/mongoose/mongooseDatabaseService');

exports.createAttendance = async (req,res,next)=>{
  try {
    const { date, locationId, projectId, employeeId, subcontractorId, type, hoursWorked, dayRate } = req.body;
    if(locationId && projectId) return res.status(400).send('Only location or project allowed');
    if(!locationId && !projectId) return res.status(400).send('Location or project required');
    if(hoursWorked && dayRate) return res.status(400).send('Hours or dayRate only');
    const attendance = await mdb.attendance.create({ date, locationId:locationId||null, projectId:projectId||null, employeeId:employeeId||null, subcontractorId:subcontractorId||null, type, hoursWorked:hoursWorked||null, dayRate:dayRate||null });
    res.json({attendance});
  }catch(err){ next(err); }
};

exports.readAttendance = async (req,res,next)=>{
  try {
    const attendance = await mdb.attendance.findOne({ uuid: req.params.uuid }).populate('employeeId subcontractorId locationId');
    if(!attendance) return res.status(404).send('Not found');
    res.json({attendance});
  }catch(err){ next(err); }
};

exports.updateAttendance = async (req,res,next)=>{
  try {
    const { date, locationId, projectId, employeeId, subcontractorId, type, hoursWorked, dayRate } = req.body;
    const update = { date, locationId:locationId||null, projectId:projectId||null, employeeId:employeeId||null, subcontractorId:subcontractorId||null, type, hoursWorked:employeeId?hoursWorked||null:null, dayRate:dayRate||null };
    const attendance = await mdb.attendance.findOneAndUpdate({ uuid:req.params.uuid }, update, { new:true });
    if(!attendance) return res.status(404).send('Not found');
    res.json({attendance});
  }catch(err){ next(err); }
};

exports.deleteAttendance = async (req,res,next)=>{
  try {
    await mdb.attendance.findOneAndDelete({ uuid:req.params.uuid });
    res.json({success:true});
  }catch(err){ next(err); }
};
