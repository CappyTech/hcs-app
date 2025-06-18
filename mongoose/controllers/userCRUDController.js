const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const moment = require('moment');

exports.listUsers = async (req, res, next) => {
  try {
    const users = await mdb.user.find().sort({ createdAt: -1 }).lean();
    const totalUsers = users.length;
    const roleCounts = users.reduce((acc, u) => {
      acc[u.role] = (acc[u.role] || 0) + 1;
      return acc;
    }, {});
    const recentUsers = users.filter(u =>
      u.createdAt && moment(u.createdAt).isAfter(moment().subtract(30, 'days'))
    );
    res.render(path.join('mongoose', 'user'), {
      title: 'Users',
      users,
      totalUsers,
      roleCounts,
      recentUsersCount: recentUsers.length,
    });
  } catch (err) {
    next(err);
  }
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
    res.render(path.join('users','viewUser'), {
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
