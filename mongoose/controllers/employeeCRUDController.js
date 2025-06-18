const mongoose = require('mongoose');
const mdb = require('../../services/mongoose/mongooseDatabaseService');

exports.createEmployee = async (req,res,next)=>{
  try {
    const data = req.body;
    const emp = await mdb.employee.create(data);
    res.json({employee:emp});
  }catch(err){ next(err); }
};

exports.readEmployee = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    let emp = await mdb.employee.findOne({ uuid: identifier });
    if(!emp && mongoose.Types.ObjectId.isValid(identifier)) {
      emp = await mdb.employee.findById(identifier);
    }
    if(!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/employees');
    }
    res.json({employee:emp});
  }catch(err){ next(err); }
};

exports.updateEmployee = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(identifier)
      ? { $or: [{ uuid: identifier }, { _id: identifier }] }
      : { uuid: identifier };
    const emp = await mdb.employee.findOneAndUpdate(query, req.body, { new:true });
    if(!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/employees');
    }
    res.json({employee:emp});
  }catch(err){ next(err); }
};

exports.deleteEmployee = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(identifier)
      ? { $or: [{ uuid: identifier }, { _id: identifier }] }
      : { uuid: identifier };
    await mdb.employee.findOneAndDelete(query);
    res.json({success:true});
  }catch(err){ next(err); }
};
