const config = require("../mongoose/config/listControllerConfig");

module.exports = function ensureHandlesDocuments(req, res, next) {
  const model = req.params.model?.toLowerCase();
  const modelConfig = config[model];

  if (!modelConfig || !modelConfig.handlesDocuments) {
    return res
      .status(404)
      .send(`Document support not enabled for model: ${model}`);
  }

  next();
};
