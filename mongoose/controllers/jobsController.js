const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

exports.renderJobForm = async (req,res,next)=>{
  try {
    const projects = await mdb.project.find({ Status: 1 }).sort({ Date1: -1 }).lean();
    const locations = await mdb.location.find().sort({ name: 1 }).lean();
    const employees = await mdb.employee.find().sort({ name: 1 }).lean();
    const suppliers = await mdb.supplier.find().sort({ Name: 1 }).lean();
    const jobs = await mdb.job.find().populate('projectId').populate('locationId').sort({ createdAt:-1 }).lean();
    res.render(path.join('mongoose','jobRegistration'),{
      title:'Job Registration',
      projects,
      locations,
      employees,
      suppliers,
      jobs
    });
  } catch(err){ next(err); }
};

exports.registerJob = async (req,res,next)=>{
  try {
    const { jobRef, quoteRef, projectId, locationId, description, startDate, endDate, employeeId, supplierId } = req.body;
    const job = new mdb.job({
      jobRef,
      quoteRef: quoteRef || null,
      projectId: projectId || null,
      locationId: locationId || null,
      employeeId: employeeId || null,
      supplierId: supplierId || null,
      description,
      startDate: startDate || null,
      endDate: endDate || null,
      status: 'scheduled'
    });
    await job.save();

    try {
      const user = employeeId
        ? await mdb.user.findOne({ employeeId })
        : supplierId
          ? await mdb.user.findOne({ subcontractorId: supplierId })
          : null;
      if (user) {
        const taskService = require('../../services/mongoose/taskService');
        await taskService.createTask({
          title: `Job Scheduled: ${jobRef}`,
          description: description || '',
          userId: user._id,
          jobId: job._id,
          dueDate: startDate || null,
          recurrence: 'none'
        });
      }
    } catch (err) {
      // non-fatal
    }

    req.flash('success','Job registered');
    res.redirect('/job/register');
  }catch(err){ next(err); }
};

exports.listJobs = async (req,res,next)=>{
  try {
    const jobs = await mdb.job.find().populate('projectId').populate('locationId').sort({ createdAt:-1 }).lean();
    res.render(path.join('mongoose','jobs'),{ title:'Jobs', jobs });
  }catch(err){ next(err); }
};
