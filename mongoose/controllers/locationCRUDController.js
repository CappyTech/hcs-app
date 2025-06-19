const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

exports.renderCreateLocationForm = (req, res) => {
  res.render(path.join('mongoose', 'createLocation'), {
    title: 'Create Location'
  });
};

exports.renderUpdateLocationForm = async (req, res, next) => {
  try {
    const loc = await mdb.location.findOne({ uuid: req.params.uuid });
    if (!loc) {
      req.flash('error', 'Location not found.');
      return res.redirect('/dashboard/location');
    }
    res.render(path.join('mongoose', 'updateLocation'), {
      title: 'Update Location',
      location: loc
    });
  } catch (err) {
    next(err);
  }
};

exports.createLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.create(req.body);
    req.flash('success', 'Location created successfully.');
    res.redirect('/dashboard/location');
  }catch(err){ next(err); }
};

exports.readLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.findOne({ uuid:req.params.uuid });
    if (!loc) {
      req.flash('error', 'Location not found.');
      return res.redirect('/locations');
    }
    res.render(path.join('mongoose','viewLocation'), {
      title: 'View Location',
      location: loc
    });
  }catch(err){ next(err); }
};

exports.updateLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.findOneAndUpdate({ uuid:req.params.uuid }, req.body, { new:true });
    if (!loc) {
      req.flash('error', 'Location not found.');
      return res.redirect('/locations');
    }
    req.flash('success', 'Location updated successfully.');
    res.redirect('/dashboard/location');
  }catch(err){ next(err); }
};

exports.deleteLocation = async (req,res,next)=>{
  try {
    await mdb.location.findOneAndDelete({ uuid:req.params.uuid });
    req.flash('success', 'Location deleted successfully.');
    res.redirect('/dashboard/location');
  }catch(err){ next(err); }
};
