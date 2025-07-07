const path = require('path');
const mdb = require('../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');
const listConfig = require('../config/listControllerConfig');
const crudConfig = require('../config/CRUDControllerConfig');
const denyGuard = (config, op) => Array.isArray(config.deny) && config.deny.includes(op);
const crudController = {};
const capitalize = str => str.charAt(0).toUpperCase() + str.slice(1);

// Merge list and CRUD configs
const getMergedConfig = (modelName) => ({
  ...(listConfig[modelName] || {}),
  ...(crudConfig[modelName] || {})
});

// Extract schema from Mongoose model and config
const extractSchema = (model, config = {}) => {
  const schema = {};
  const paths = model.schema.paths;

  Object.entries(paths).forEach(([field, path]) => {
    if ((config.hideFields || []).includes(field) || field === '__v') return;

    schema[field] = {
      type: path.instance,
      required: path.isRequired || false,
      enum: path.enumValues?.length ? path.enumValues : undefined,
      default: path.defaultValue,
      label: config.labelOverrides?.[field] ||
             field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      readOnly: config.readOnly?.includes?.(field),
      ref: path.options?.ref?.toLowerCase() || null
    };
  });

  // Order fields
  if (Array.isArray(config.fieldOrder)) {
    const ordered = {};
    config.fieldOrder.forEach(key => {
      if (schema[key]) ordered[key] = schema[key];
    });
    if (!config.strictOrder) {
      for (const key in schema) {
        if (!ordered[key]) ordered[key] = schema[key];
      }
    }
    return ordered;
  }

  return schema;
};

// Fetch reference data (for fields with .ref)
const fetchReferenceData = async (schema) => {
  const referenceData = {};

  for (const [key, field] of Object.entries(schema)) {
    if (field.ref && mdb[field.ref]) {
      referenceData[key] = await mdb[field.ref]
        .find()
        .select('uuid name Name InvoiceNumber Customer jobRef title username')
        .lean();
    }
  }

  return referenceData;
};

// Register handlers for each Mongoose model
for (const modelName of Object.keys(mdb)) {
  const model = mdb[modelName];
  if (typeof model?.find !== 'function') continue;

  const Model = model;
  const baseName = capitalize(modelName);
  const config = getMergedConfig(modelName);

if (!denyGuard(config, 'r')) {
  // READ
  crudController[`read${baseName}`] = async (req, res, next) => {
    try {
      const item = await Model.findOne({ uuid: req.params.uuid }).lean();
      if (!item) return res.status(404).render(path.join('mongoose', 'error'));

      const schema = extractSchema(Model, config);

      res.render(path.join('tailwindcss', 'partials', 'form-read'), {
        title: `${config.title || baseName} Details`,
        item,
        schema,
        basePath: modelName
      });
    } catch (err) {
      logger.error(`❌ Error reading ${modelName}: ${err.message}`);
      next(err);
    }
  };
}
if (!denyGuard(config, 'c')) {
  // CREATE
  crudController[`create${baseName}`] = async (req, res, next) => {
    if (req.method === 'GET') {
      const schema = extractSchema(Model, config);
      const referenceData = await fetchReferenceData(schema);

      let formData = { ...req.query };

      // 1. Attempt direct UUID → ObjectId mapping for any known .ref fields
      for (const key of Object.keys(formData)) {
        const refField = schema[key];
        if (refField?.ref && mdb[refField.ref]) {
          const candidate = await mdb[refField.ref]
            .findOne({ uuid: formData[key] })
            .select('_id')
            .lean();

          if (candidate) {
            formData[key] = candidate._id.toString();
          }
        }
      }

      // 2. Fallback: if just ?uuid=... is passed, try matching it to employee/supplier
      if (req.query.uuid) {
        const employee = await mdb.employee.findOne({ uuid: req.query.uuid }).select('_id').lean();
        const subcontractor = await mdb.supplier.findOne({ uuid: req.query.uuid }).select('_id').lean();

        if (employee && !formData.employeeId) {
          formData.employeeId = employee._id.toString();
        } else if (subcontractor && !formData.subcontractorId) {
          formData.subcontractorId = subcontractor._id.toString();
        }
      }

      return res.render(path.join('tailwindcss', 'partials', 'form-create'), {
        title: `Create ${config.title || baseName}`,
        formData,
        schema,
        referenceData,
        formAction: `/${modelName}`,
        basePath: modelName
      });
    }

    try {
      // Clean up submitted data: convert empty strings to undefined
      const cleanedData = {};
      for (const [key, value] of Object.entries(req.body)) {
        cleanedData[key] = value === '' ? undefined : value;
      }

      const doc = new Model(cleanedData);
      await doc.save();
      res.redirect(`/${modelName}s`);
    } catch (err) {
      logger.error(`❌ Error creating ${modelName}: ${err.message}`);
      next(err);
    }
  };
}
if (!denyGuard(config, 'u')) {
  // UPDATE
  crudController[`update${baseName}`] = async (req, res, next) => {
    if (req.method === 'GET') {
      try {
        const item = await Model.findOne({ uuid: req.params.uuid }).lean();
        if (!item) return res.status(404).render('mongoose/notFound');

        const schema = extractSchema(Model, config);
        const referenceData = await fetchReferenceData(schema);

        return res.render(path.join('tailwindcss', 'partials', 'form-update'), {
          title: `Update ${config.title || baseName}`,
          formData: item,
          schema,
          referenceData,
          formAction: `/${modelName}/${item.uuid}`,
          basePath: modelName
        });
      } catch (err) {
        logger.error(`❌ Error fetching ${modelName} for update: ${err.message}`);
        return next(err);
      }
    }

    try {
      await Model.findOneAndUpdate({ uuid: req.params.uuid }, req.body);
      res.redirect(`/${modelName}s`);
    } catch (err) {
      logger.error(`❌ Error updating ${modelName}: ${err.message}`);
      next(err);
    }
  };
}
if (!denyGuard(config, 'd')) {
  // DELETE
  crudController[`delete${baseName}`] = async (req, res, next) => {
    if (req.method === 'GET') {
      try {
        const item = await Model.findOne({ uuid: req.params.uuid }).lean();
        if (!item) return res.status(404).render(path.join('mongoose', 'error'));

        return res.render(path.join('tailwindcss', 'partials', 'form-delete'), {
          title: `Delete ${config.title || baseName}`,
          item,
          cancelUrl: `/${modelName}s`,
          formAction: `/${modelName}/${item.uuid}/delete`
        });
      } catch (err) {
        logger.error(`❌ Error preparing delete for ${modelName}: ${err.message}`);
        return next(err);
      }
    }

    try {
      await Model.findOneAndDelete({ uuid: req.params.uuid });
      res.redirect(`/${modelName}s`);
    } catch (err) {
      logger.error(`❌ Error deleting ${modelName}: ${err.message}`);
      next(err);
    }
  };
}
}

module.exports = crudController;
