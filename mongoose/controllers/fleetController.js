const path = require('path');
const fleetService = require('../services/fleetService');

exports.getFleetOverview = async (req, res, next) => {
  try {
    const expiryDays = parseInt(req.query.days) || 30;

    const overview = await fleetService.getFleetOverview({ expiryDays });

    res.render(path.join('tailwindcss', 'fleet', 'overview'), {
      title: 'Fleet Overview',
      ...overview,
    });
  } catch (err) {
    next(err);
  }
};
