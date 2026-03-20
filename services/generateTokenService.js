const jwt = require("jsonwebtoken");

module.exports = (payload, expiresIn = "8h") => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};
