const mdb = require('../../services/mongoose/mongooseDatabaseService');

exports.createLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.create(req.body);
    res.json({location:loc});
  }catch(err){ next(err); }
};

exports.readLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.findOne({ uuid:req.params.uuid });
    if(!loc) return res.status(404).send('Not found');
    res.json({location:loc});
  }catch(err){ next(err); }
};

exports.updateLocation = async (req,res,next)=>{
  try {
    const loc = await mdb.location.findOneAndUpdate({ uuid:req.params.uuid }, req.body, { new:true });
    if(!loc) return res.status(404).send('Not found');
    res.json({location:loc});
  }catch(err){ next(err); }
};

exports.deleteLocation = async (req,res,next)=>{
  try {
    await mdb.location.findOneAndDelete({ uuid:req.params.uuid });
    res.json({success:true});
  }catch(err){ next(err); }
};
