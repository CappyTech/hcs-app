module.exports = (req, res, next) => {
  let flashData = {};
  const raw = req.cookies?.__flash;
  if (raw) {
    try {
      flashData = JSON.parse(raw);
    } catch (e) {
      flashData = {};
    }
    res.clearCookie('__flash');
  }

  const flashToSet = {};

  req.flash = (type, message) => {
    if (typeof message !== 'undefined') {
      if (!flashToSet[type]) flashToSet[type] = [];
      flashToSet[type].push(message);
      // Also expose to current request so same-request renders see the message
      if (!flashData[type]) flashData[type] = [];
      flashData[type].push(message);
    } else {
      const messages = flashData[type] || [];
      delete flashData[type];
      return messages;
    }
  };

  res.locals.successMessage = flashData.success || null;
  res.locals.errorMessage = flashData.error || null;
  res.locals.flash = flashData;

  // Inject flash cookie safely before headers are sent
  const originalEnd = res.end;
  res.end = function (...args) {
    if (Object.keys(flashToSet).length > 0 && !res.headersSent) {
      res.cookie('__flash', JSON.stringify(flashToSet), {
        maxAge: 5000,
        httpOnly: false,
      });
    }
    originalEnd.apply(this, args);
  };

  next();
};
