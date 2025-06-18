const cookieParser = require('cookie-parser');

module.exports = (req, res, next) => {
  // Parse flash from cookie if exists
  const raw = req.cookies?.__flash;
  let flashMessages = {};

  if (raw) {
    try {
      flashMessages = JSON.parse(raw);
      res.clearCookie('__flash');
    } catch (e) {
      flashMessages = {};
    }
  }

  // Expose to views
  res.locals.flash = flashMessages;

  // Define req.flash(type, message)
  req.flash = (type, message) => {
    const existing = JSON.parse(req.cookies?.__flash || '{}');
    const updated = {
      ...existing,
      [type]: Array.isArray(existing[type])
        ? [...existing[type], message]
        : [message],
    };
    res.cookie('__flash', JSON.stringify(updated), {
      maxAge: 5000,
      httpOnly: false,
    });
  };

  next();
};
