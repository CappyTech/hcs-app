const moment = require('moment');
const path = require('path');
const attendanceService = require('../services/attendanceServicesMongoose');

exports.getDailyAttendance = async (req,res,next)=>{
  const date = req.params.date || moment().format('YYYY-MM-DD');
  try {
    const attendance = await attendanceService.getAttendanceForDay(date);
    res.render(path.join('mongoose','dailyAttendance'),{
      moment,
      attendance,
      date,
      currentTab:'daily'
    });
  }catch(err){
    next(err);
  }
};
