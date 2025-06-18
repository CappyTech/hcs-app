const path = require('path');
const mdb = require('../../services/mongoose/mongooseDatabaseService');

exports.renderJobForm = async (req,res,next)=>{
  try {
    const projects = await mdb.project.find({ Status: 1 }).sort({ Date1: -1 }).lean();
    const locations = await mdb.location.find().sort({ name: 1 }).lean();
    const jobs = await mdb.job.find().populate('projectId').populate('locationId').sort({ createdAt:-1 }).lean();
    res.render(path.join('mongoose','jobRegistration'),{
      title:'Job Registration',
      projects,
      locations,
      jobs
    });
  } catch(err){ next(err); }
};

exports.registerJob = async (req,res,next)=>{
  try {
    const { jobRef, quoteRef, projectId, locationId, description, startDate, endDate } = req.body;
    const job = new mdb.job({
      jobRef,
      quoteRef: quoteRef || null,
      projectId: projectId || null,
      locationId: locationId || null,
      description,
      startDate: startDate || null,
      endDate: endDate || null,
      status: 'scheduled'
    });
    await job.save();
    req.flash('success','Job registered');
    res.redirect('/job/register');
  }catch(err){ next(err); }
};

exports.listJobs = async (req,res,next)=>{
  try {
    const jobs = await mdb.job.find().populate('projectId').populate('locationId').sort({ createdAt:-1 }).lean();
    res.render(path.join('mongoose','jobRegList'),{ title:'Jobs', jobs });
  }catch(err){ next(err); }
};
