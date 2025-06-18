const mdb = require('../../services/mongoose/mongooseDatabaseService');

exports.createUser = async (req, res, next) => {
  try {
    const user = await mdb.user.create(req.body);
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

exports.readUser = async (req, res, next) => {
  try {
    const user = await mdb.user.findOne({ uuid: req.params.uuid });
    if (!user) return res.status(404).send('Not found');
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

exports.updateUser = async (req, res, next) => {
  try {
    const user = await mdb.user.findOneAndUpdate(
      { uuid: req.params.uuid },
      req.body,
      { new: true }
    );
    if (!user) return res.status(404).send('Not found');
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    await mdb.user.findOneAndDelete({ uuid: req.params.uuid });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
