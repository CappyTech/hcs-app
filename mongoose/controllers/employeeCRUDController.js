const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

exports.renderCreateEmployeeForm = (req, res) => {
  res.render(path.join('mongoose', 'createEmployee'), {
    title: 'Create Employee'
  });
};

exports.renderUpdateEmployeeForm = async (req, res, next) => {
  try {
    const identifier = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(identifier)
      ? { $or: [{ uuid: identifier }, { _id: identifier }] }
      : { uuid: identifier };
    const emp = await mdb.employee.findOne(query);
    if (!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/employees');
    }

    const managers = await mdb.employee
      .find({ _id: { $ne: emp._id } })
      .sort({ name: 1 })
      .lean();

    res.render(path.join('mongoose', 'employee', 'updateEmployee'), {
      title: 'Update Employee',
      employee: emp,
      managers
    });
  } catch (err) {
    next(err);
  }
};

exports.createEmployee = async (req,res,next)=>{
  try {
    const data = req.body;
    const emp = await mdb.employee.create(data);
    req.flash('success', 'Employee created successfully.');
    res.redirect('/employees');
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
    res.render(path.join('mongoose', 'employee', 'viewEmployee'), {
      title: 'Employee',
      employee: emp
    });
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
    req.flash('success', 'Employee updated successfully.');
    res.redirect('/employees');
  }catch(err){ next(err); }
};

exports.deleteEmployee = async (req,res,next)=>{
  try {
    const identifier = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(identifier)
      ? { $or: [{ uuid: identifier }, { _id: identifier }] }
      : { uuid: identifier };
    await mdb.employee.findOneAndDelete(query);
    req.flash('success', 'Employee deleted successfully.');
    res.redirect('/employees');
  }catch(err){ next(err); }
};
