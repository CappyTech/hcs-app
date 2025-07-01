const mongoose = require('mongoose');
const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const moment = require('moment-timezone');

exports.listLocations = async (req, res, next) => {
  try {
    const locations = await mdb.location.find().sort({ Created: -1 }).lean();
    const totalLocations = locations.length;

    const recentLocations = locations.filter(
      loc => loc.Created && moment(loc.Created).isAfter(moment().subtract(30, 'days'))
    ).length;

    res.render(path.join('mongoose', 'location', 'listLocation'), {
      title: 'Locations',
      locations,
      totalLocations,
      recentLocations
    });
  } catch (error) {
    next(error);
  }
};

exports.renderCreateLocationForm = (req, res) => {
  res.render(path.join('mongoose', 'location', 'createLocation'), {
    title: 'Create Location'
  });
};

exports.renderUpdateLocationForm = async (req, res, next) => {
  try {
    const loc = await mdb.location.findOne({ uuid: req.params.uuid });
    if (!loc) {
      req.flash('error', 'Location not found.');
      return res.redirect('locations');
    }
    res.render(path.join('mongoose', 'location', 'updateLocation'), {
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
    res.redirect('/locations');
  }catch(err){ next(err); }
};

exports.readLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.findOne({ uuid:req.params.uuid });
    if (!loc) {
      req.flash('error', 'Location not found.');
      return res.redirect('/locations');
    }
    res.render(path.join('mongoose', 'location', 'viewLocation'), {
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
    res.redirect('/locations');
  }catch(err){ next(err); }
};

exports.deleteLocation = async (req,res,next)=>{
  try {
    await mdb.location.findOneAndDelete({ uuid:req.params.uuid });
    req.flash('success', 'Location deleted successfully.');
    res.redirect('/locations');
  }catch(err){ next(err); }
};
