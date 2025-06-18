const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

exports.listUsers = async (req, res, next) => {
  try {
    const users = await mdb.user.find().sort({ createdAt: -1 }).lean();
    res.render(path.join('mongoose', 'user'), {
      title: 'Users',
      users
    });
  } catch (err) {
    next(err);
  }
};

exports.renderCreateUserForm = (req, res) => {
  res.render(path.join('mongoose', 'createUser'), {
    title: 'Create User'
  });
};

exports.createUser = async (req, res, next) => {
  try {
    const user = await mdb.user.create(req.body);
    req.flash('success', 'User created successfully.');
    res.redirect('/dashboard/user');
  } catch (err) {
    next(err);
  }
};

exports.readUser = async (req, res, next) => {
  try {
    const user = await mdb.user.findOne({ uuid: req.params.uuid });
    if (!user) return res.status(404).send('Not found');
    res.render(path.join('mongoose','viewUser'), {
      title: 'User',
      user
    });
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
    req.flash('success', 'User updated successfully.');
    res.redirect('/dashboard/user');
  } catch (err) {
    next(err);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    await mdb.user.findOneAndDelete({ uuid: req.params.uuid });
    req.flash('success', 'User deleted successfully.');
    res.redirect('/dashboard/user');
  } catch (err) {
    next(err);
  }
};
