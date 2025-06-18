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
    const emp = await mdb.employee.findOne({ uuid:req.params.uuid });
    if(!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/employees');
    }
    res.json({employee:emp});
  }catch(err){ next(err); }
};

exports.updateEmployee = async (req,res,next)=>{
  try {
    const emp = await mdb.employee.findOneAndUpdate({ uuid:req.params.uuid }, req.body, { new:true });
    if(!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/employees');
    }
    res.json({employee:emp});
  }catch(err){ next(err); }
};

exports.deleteEmployee = async (req,res,next)=>{
  try {
    await mdb.employee.findOneAndDelete({ uuid:req.params.uuid });
    res.json({success:true});
  }catch(err){ next(err); }
};
