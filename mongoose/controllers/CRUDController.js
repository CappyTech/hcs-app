const path = require("path");
const mdb = require("../services/mongooseDatabaseService");
const logger = require("../../services/loggerService");
const listControllerConfig = require("../config/listControllerConfig");
const CRUDControllerConfig = require("../config/CRUDControllerConfig");
const { scopeQuery } = require("../../services/dataScopingService");
const rbac = require("../config/rolePermissionsConfig");
const denyGuard = (config, op) =>
  Array.isArray(config.deny) && config.deny.includes(op);
const crudController = {};
const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);
const mongoose = require("mongoose");
const e = require("express");
const holidayAccrualService = require("../services/holidayAccrualService");

/**
 * Sync parent vehicle record when a sub-model (fuel log, mileage log, service) is created/updated.
 * Updates currentMileage, lastMileageUpdate, lastServiceDate, nextServiceDueDate, etc.
 */
async function syncVehicleFromSubModel(modelName, doc) {
  const vehicleSubModels = [
    "vehicleFuelLog",
    "vehicleMileageLog",
    "vehicleService",
  ];
  if (!vehicleSubModels.includes(modelName) || !doc.vehicleId) return;
  if (!mdb.INTERNAL?.vehicle) return;

  try {
    const updates = {};

    if (modelName === "vehicleFuelLog" && doc.mileageAtFillUp) {
      // Update current mileage if this fill-up reading is higher
      const vehicle = await mdb.INTERNAL.vehicle
        .findById(doc.vehicleId)
        .select("currentMileage")
        .lean();
      if (!vehicle) return;
      if (
        !vehicle.currentMileage ||
        doc.mileageAtFillUp > vehicle.currentMileage
      ) {
        updates.currentMileage = doc.mileageAtFillUp;
        updates.lastMileageUpdate = new Date();
      }
    }

    if (modelName === "vehicleMileageLog" && doc.endMileage) {
      const vehicle = await mdb.INTERNAL.vehicle
        .findById(doc.vehicleId)
        .select("currentMileage")
        .lean();
      if (!vehicle) return;
      if (!vehicle.currentMileage || doc.endMileage > vehicle.currentMileage) {
        updates.currentMileage = doc.endMileage;
        updates.lastMileageUpdate = new Date();
      }
    }

    if (modelName === "vehicleService" && doc.status === "Completed") {
      updates.lastServiceDate = doc.date;
      if (doc.mileageAtService) {
        updates.lastServiceMileage = doc.mileageAtService;

        const vehicle = await mdb.INTERNAL.vehicle
          .findById(doc.vehicleId)
          .select("currentMileage")
          .lean();
        if (
          vehicle &&
          (!vehicle.currentMileage ||
            doc.mileageAtService > vehicle.currentMileage)
        ) {
          updates.currentMileage = doc.mileageAtService;
          updates.lastMileageUpdate = new Date();
        }
      }
      if (doc.nextServiceDueDate)
        updates.nextServiceDueDate = doc.nextServiceDueDate;
      if (doc.nextServiceDueMileage)
        updates.nextServiceDueMileage = doc.nextServiceDueMileage;
    }

    if (Object.keys(updates).length > 0) {
      await mdb.INTERNAL.vehicle.findByIdAndUpdate(doc.vehicleId, updates);
      logger.info(
        `🔧 Synced vehicle ${doc.vehicleId} from ${modelName}: ${Object.keys(updates).join(", ")}`,
      );
    }
  } catch (err) {
    logger.warn(`Failed to sync vehicle from ${modelName}: ${err.message}`);
  }
}

// Merge list and CRUD configs
const getMergedConfig = (modelName) => ({
  ...(listControllerConfig[modelName] || {}),
  ...(CRUDControllerConfig[modelName] || {}),
});

// Extract schema from Mongoose model and config
const extractSchema = (model, config = {}) => {
  const schema = {};
  const paths = model.schema.paths;

  Object.entries(paths).forEach(([field, path]) => {
    if ((config.hideFields || []).includes(field) || field === "__v") return;

    schema[field] = {
      type: path.instance,
      required: path.isRequired || false,
      enum: path.enumValues?.length ? path.enumValues : undefined,
      default: path.defaultValue,
      label:
        config.labelOverrides?.[field] ||
        field
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
      readOnly: config.readOnly?.includes?.(field),
      ref:
        path.options?.ref?.toLowerCase() ||
        (Array.isArray(path.options?.type) &&
          path.options.type[0]?.ref?.toLowerCase()) ||
        null,
      isArray: Array.isArray(path.options?.type),
      refDenyCreate: false, // updated below if ref model denies create
    };

    // Check if the referenced model denies create
    if (schema[field].ref) {
      const refConfig = getMergedConfig(schema[field].ref);
      if (denyGuard(refConfig, "c")) {
        schema[field].refDenyCreate = true;
      }
    }
  });

  // Order fields
  if (Array.isArray(config.fieldOrder)) {
    const ordered = {};
    config.fieldOrder.forEach((key) => {
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
// skipFilters: when true, ignore referenceFilters (used by read/delete views to resolve any referenced item)
const fetchReferenceData = async (
  schema,
  config = {},
  { skipFilters = false } = {},
) => {
  const referenceData = {};

  for (const [key, field] of Object.entries(schema)) {
    if (!field.ref) continue;
    // Look up the referenced model across all namespaces
    const refModel =
      mdb.REST?.[field.ref] ||
      mdb.INTERNAL?.[field.ref] ||
      mdb.PAPERLESS?.[field.ref] ||
      mdb[field.ref];
    if (!refModel || typeof refModel.find !== "function") continue;
    const filter = skipFilters ? {} : config.referenceFilters?.[key] || {};
    referenceData[key] = await refModel
      .find(filter)
      .select(
        "uuid name Name InvoiceNumber Customer jobRef title username Number Status status Id address city postalCode",
      )
      .lean();
  }

  return referenceData;
};

function validateXorGroups(data, xorGroups) {
  const errors = [];

  xorGroups.forEach((group) => {
    const filled = group.filter((field) => {
      const val = data[field];
      return (
        val !== undefined &&
        val !== null &&
        val !== "" &&
        !(Array.isArray(val) && val.length === 0)
      );
    });

    if (filled.length > 1) {
      errors.push(
        `Only one of [${group.join(", ")}] can be filled. Currently filled: ${filled.join(", ")}`,
      );
    }
  });

  return errors;
}

// Recursively clean nested objects from form body (bracket-notation parsed by qs)
// For create: convert empty strings to undefined so Mongoose defaults apply
function cleanBodyForCreate(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      result[key] = cleanBodyForCreate(val);
    } else {
      result[key] = val === "" ? undefined : val;
    }
  }
  return result;
}

// For update: remove empty strings entirely so unchanged fields are not overwritten
function cleanBodyForUpdate(obj) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const nested = cleanBodyForUpdate(val);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else if (val !== "") {
      result[key] = val;
    }
  }
  return result;
}

// Register handlers for both REST and INTERNAL namespaces
for (const namespace of ["REST", "INTERNAL"]) {
  if (!mdb[namespace]) continue;
  for (const modelName of Object.keys(mdb[namespace])) {
    const model = mdb[namespace][modelName];
    if (typeof model?.find !== "function") continue;

    const Model = model;
    const baseName = capitalize(modelName);
    const config = getMergedConfig(modelName);

    if (!denyGuard(config, "r")) {
      // READ
      crudController[`read${baseName}`] = async (req, res, next) => {
        try {
          let item = await Model.findOne({ uuid: req.params.uuid }).lean();
          if (!item)
            return res.status(404).render(path.join("mongoose", "error"));

          // ── Ownership check: non-admin own-only roles must own this record ──
          if (req.user && req.user.role !== "admin") {
            const customPerms = req.user?.customPermissions || {};
            const { allowed, ownOnly } = rbac.canAccess(
              req.user.role,
              modelName,
              "r",
              customPerms,
            );
            if (ownOnly) {
              const filter = await scopeQuery(req, modelName, "r");
              if (!filter)
                return res.status(403).render(path.join("mongoose", "error"));
              // Verify the fetched item matches ownership filter
              const ownerMatch = Object.entries(filter).every(([k, v]) => {
                const itemVal = item[k];
                return itemVal && String(itemVal) === String(v);
              });
              if (!ownerMatch)
                return res.status(403).render(path.join("mongoose", "error"));
            }
          }

          // Flatten nested data objects (e.g., when hcs-sync stores { number, data: {...}, syncedAt })
          if (config.flattenField) {
            const nested = item[config.flattenField];
            if (
              nested &&
              typeof nested === "object" &&
              !Array.isArray(nested)
            ) {
              const { [config.flattenField]: _, ...rest } = item;
              item = { ...rest, ...nested };
            }
          }

          const schema = extractSchema(Model, config);
          const referenceData = await fetchReferenceData(schema, config, {
            skipFilters: true,
          });

          // If reading a REST supplier, include their related purchases
          if (modelName === "supplier" && mdb.REST?.purchase) {
            try {
              const listCfg = listControllerConfig["purchase"] || {};
              const pFlatten = listCfg.flattenField || null;
              const filterKey = pFlatten
                ? `${pFlatten}.SupplierId`
                : "SupplierId";
              const filter = { [filterKey]: item.Id };

              // Optional filters from query string
              // ?status=Paid|Unpaid|All
              if (
                req.query.status &&
                req.query.status.toLowerCase() !== "all"
              ) {
                const statusKey = pFlatten ? `${pFlatten}.Status` : "Status";
                filter[statusKey] = req.query.status;
              }
              // Date range on IssuedDate: ?from=YYYY-MM-DD&to=YYYY-MM-DD
              if (req.query.from || req.query.to) {
                const dateKey = pFlatten
                  ? `${pFlatten}.IssuedDate`
                  : "IssuedDate";
                filter[dateKey] = {};
                if (req.query.from)
                  filter[dateKey].$gte = new Date(req.query.from);
                if (req.query.to) filter[dateKey].$lte = new Date(req.query.to);
              }

              // Sorting: allow query override, else use list config, fallback IssuedDate desc
              const rawSortField =
                req.query.sort || listCfg.sortField || "IssuedDate";
              const sortOrder =
                (req.query.order
                  ? Number(req.query.order)
                  : typeof listCfg.sortOrder === "number"
                    ? listCfg.sortOrder
                    : -1) || -1;
              const sortSpec = { [rawSortField]: sortOrder };

              let query;
              if (pFlatten) {
                // When data is nested, skip .select() since fields live inside the subdocument
                query = mdb.REST.purchase.find(filter).sort(sortSpec);
              } else {
                // Projection based on list config fieldOrder, honoring hideFields, plus extras needed by read/CIS
                const extraFields = [
                  "uuid",
                  "SupplierReference",
                  "IssuedDate",
                  "PaidDate",
                  "PaymentLines",
                  "TaxYear",
                  "TaxMonth",
                ];
                const baseFields = Array.from(
                  new Set([
                    ...(Array.isArray(listCfg.fieldOrder)
                      ? listCfg.fieldOrder
                      : []),
                    ...extraFields,
                  ]),
                );

                const hideSet = new Set(
                  Array.isArray(listCfg.hideFields) ? listCfg.hideFields : [],
                );
                const filteredFields = baseFields.filter(
                  (f) => !hideSet.has(f) || extraFields.includes(f),
                );

                const selectParts = [...filteredFields];
                if (hideSet.has("_id")) selectParts.push("-_id");
                const selectProjection = selectParts.join(" ");
                query = mdb.REST.purchase
                  .find(filter)
                  .select(selectProjection)
                  .sort(sortSpec);
              }

              // Optional limit/page
              if (req.query.limit) {
                query.limit(Math.max(1, Number(req.query.limit)));
              }
              if (req.query.page && req.query.limit) {
                const page = Math.max(1, Number(req.query.page));
                const limit = Math.max(1, Number(req.query.limit));
                query.skip((page - 1) * limit);
              }

              let purchases = await query.lean();

              // Flatten nested data if purchases use the hcs-sync format
              if (pFlatten) {
                purchases = purchases.map((p) => {
                  const nested = p[pFlatten];
                  if (
                    nested &&
                    typeof nested === "object" &&
                    !Array.isArray(nested)
                  ) {
                    const { [pFlatten]: _, ...rest } = p;
                    return { ...rest, ...nested };
                  }
                  return p;
                });
              }

              item.purchases = purchases;
            } catch (e) {
              logger.warn(
                `Failed to fetch purchases for supplier ${item.Id}: ${e.message}`,
              );
              item.purchases = [];
            }
          }

          // 🔽 Inject related records for vehicle read view
          if (modelName === "vehicle" && mdb.INTERNAL) {
            try {
              const vehicleObjId = item._id;
              if (mdb.INTERNAL.vehicleFuelLog) {
                item.fuelLogs = await mdb.INTERNAL.vehicleFuelLog
                  .find({ vehicleId: vehicleObjId })
                  .sort({ date: -1 })
                  .limit(50)
                  .lean();
              }
              if (mdb.INTERNAL.vehicleMileageLog) {
                item.mileageLogs = await mdb.INTERNAL.vehicleMileageLog
                  .find({ vehicleId: vehicleObjId })
                  .sort({ date: -1 })
                  .limit(50)
                  .lean();
              }
              if (mdb.INTERNAL.vehicleService) {
                item.serviceHistory = await mdb.INTERNAL.vehicleService
                  .find({ vehicleId: vehicleObjId })
                  .sort({ date: -1 })
                  .limit(50)
                  .lean();
              }
            } catch (e) {
              logger.warn(
                `Failed to fetch related records for vehicle ${item.uuid}: ${e.message}`,
              );
              item.fuelLogs = [];
              item.mileageLogs = [];
              item.serviceHistory = [];
            }
          }

          // 🔽 Inject documents if the model config says it handles them
          if (config.handlesDocuments) {
            const fs = require("fs").promises;
            const sanitize = require("sanitize-filename");
            const dirName = sanitize(item.uuid.toString());
            const dirPath = path.join(
              __dirname,
              "../../public",
              modelName,
              dirName,
            );

            try {
              const allFiles = await fs.readdir(dirPath);
              item.documents = allFiles
                .filter((name) => !name.startsWith("."))
                .map((name) => ({
                  name,
                  url: `/${modelName}/${encodeURIComponent(item.uuid)}/view/${encodeURIComponent(name)}`,
                }));
            } catch (err) {
              logger.warn(`⚠️ No documents found for ${modelName}/${dirName}`);
              item.documents = [];
            }
          }

          // Determine if current user can update/delete this model
          const _cp = req.user?.customPermissions || {};
          const canUpdate =
            req.user?.role === "admin" ||
            rbac.canAccess(req.user?.role, modelName, "u", _cp).allowed;
          const canDelete =
            req.user?.role === "admin" ||
            rbac.canAccess(req.user?.role, modelName, "d", _cp).allowed;

          // Allow per-model custom read view + extra locals
          const viewPath =
            config.readView ||
            path.join("tailwindcss", "partials", "form-read");
          let extraLocals = {};
          if (typeof config.readLocals === "function") {
            try {
              extraLocals = (await config.readLocals(item, req)) || {};
            } catch (e) {
              logger.warn(`readLocals for ${modelName} failed: ${e.message}`);
            }
          }

          res.render(viewPath, {
            title: `${config.title || baseName} Details`,
            item,
            schema,
            basePath: modelName,
            referenceData,
            config,
            actions: config.actions || [],
            canUpdate,
            canDelete,
            ...extraLocals,
          });
        } catch (err) {
          logger.error(`❌ Error reading ${modelName}: ${err.message}`);
          next(err);
        }
      };
    }
    if (!denyGuard(config, "c")) {
      // CREATE
      crudController[`create${baseName}`] = async (req, res, next) => {
        if (req.method === "GET") {
          const schema = extractSchema(Model, config);
          const referenceData = await fetchReferenceData(schema, config);

          let formData = { ...req.query };

          // 1. Attempt direct UUID → ObjectId mapping for any known .ref fields
          for (const key of Object.keys(formData)) {
            const refField = schema[key];
            // Try both namespaces for refField
            const refModel =
              mdb.REST?.[refField?.ref] || mdb.INTERNAL?.[refField?.ref];
            if (refField?.ref && refModel) {
              const candidate = await refModel
                .findOne({ uuid: formData[key] })
                .select("_id")
                .lean();

              if (candidate) {
                formData[key] = candidate._id.toString();
              }
            }
          }

          // 2. Fallback: if just ?uuid=... is passed, try matching it to employee/supplier
          if (req.query.uuid) {
            const employee = mdb.INTERNAL?.employee
              ?.findOne({ uuid: req.query.uuid })
              .select("_id")
              .lean();
            const subcontractor = mdb.REST?.supplier
              ?.findOne({ uuid: req.query.uuid })
              .select("Id Name")
              .lean();

            if (employee && !formData.employeeId) {
              formData.employeeId = (await employee)?._id?.toString();
            } else if (subcontractor && !formData.subcontractorId) {
              formData.subcontractorId = (await subcontractor)?.Id;
            }
          }

          return res.render(
            path.join("tailwindcss", "partials", "form-create"),
            {
              title: `Create ${config.title || baseName}`,
              formData,
              schema,
              referenceData,
              formAction: `/${modelName}`,
              basePath: modelName,
              config,
              errors: [], // ✅ Now safe
            },
          );
        }

        try {
          if (config?.xorGroups) {
            const xorErrors = validateXorGroups(req.body, config.xorGroups);
            if (xorErrors.length > 0) {
              const schema = extractSchema(Model, config);
              const referenceData = await fetchReferenceData(schema, config);

              return res
                .status(400)
                .render(path.join("tailwindcss", "partials", "form-update"), {
                  title: `Create ${config.title || baseName}`,
                  formData: req.body,
                  schema,
                  referenceData,
                  formAction: `/${modelName}/${req.params.uuid}`,
                  basePath: modelName,
                  listControllerConfig: listControllerConfig[modelName] || {},
                  config,
                  errors: xorErrors, // ✅ Now safe
                });
            }
          }
          // Clean up submitted data: convert empty strings to undefined (supports nested objects)
          const cleanedData = cleanBodyForCreate(req.body);

          // Allow per-model pre-processing before document creation
          if (typeof config.beforeCreate === "function") {
            await config.beforeCreate(cleanedData, req);
          }

          const doc = new Model(cleanedData);
          await doc.save();
          // Hook: update holiday accruals when creating attendance for an employee
          if (modelName === "attendance") {
            await holidayAccrualService.updateAccrualFromAttendance(doc);
          }
          // Hook: sync parent vehicle when creating sub-model records
          await syncVehicleFromSubModel(modelName, doc);
          res.redirect(`/${modelName}s`);
        } catch (err) {
          logger.error(`❌ Error creating ${modelName}: ${err.message}`);
          next(err);
        }
      };
    }
    if (!denyGuard(config, "u")) {
      // UPDATE
      crudController[`update${baseName}`] = async (req, res, next) => {
        if (req.method === "GET") {
          try {
            const item = await Model.findOne({ uuid: req.params.uuid }).lean();
            if (!item) return res.status(404).render("mongoose/notFound");

            const schema = extractSchema(Model, config);
            const referenceData = await fetchReferenceData(schema, config);

            // Allow per-model custom update view + extra locals
            const updateViewPath =
              config.updateView ||
              path.join("tailwindcss", "partials", "form-update");
            let extraLocals = {};
            if (typeof config.updateLocals === "function") {
              try {
                extraLocals = (await config.updateLocals(item, req)) || {};
              } catch (e) {
                logger.warn(
                  `updateLocals for ${modelName} failed: ${e.message}`,
                );
              }
            }

            return res.render(updateViewPath, {
              title: `Update ${config.title || baseName}`,
              formData: item,
              schema,
              referenceData,
              formAction: `/${modelName}/${item.uuid}`,
              basePath: modelName,
              listControllerConfig: listControllerConfig[modelName] || {},
              config,
              errors: [],
              ...extraLocals,
            });
          } catch (err) {
            logger.error(
              `❌ Error fetching ${modelName} for update: ${err.message}`,
            );
            return next(err);
          }
        }

        try {
          if (config?.xorGroups) {
            const xorErrors = validateXorGroups(req.body, config.xorGroups);
            if (xorErrors.length > 0) {
              const schema = extractSchema(Model, config);
              const referenceData = await fetchReferenceData(schema, config);

              return res
                .status(400)
                .render(path.join("tailwindcss", "partials", "form-update"), {
                  title: `Update ${config.title || baseName}`,
                  formData: req.body,
                  schema,
                  referenceData,
                  formAction: `/${modelName}/${req.params.uuid}`,
                  basePath: modelName,
                  listControllerConfig: listControllerConfig[modelName] || {},
                  config,
                  errors: xorErrors, // ✅ Now safe
                });
            }
          }
          // 1) pull down your schema so you know which fields are .ref
          const schema = extractSchema(Model, config);

          // 2) clean + map (supports nested objects from bracket-notation form fields)
          const preClean = cleanBodyForUpdate(req.body);
          const cleaned = {};
          for (const [key, val] of Object.entries(preClean)) {
            // Nested objects (e.g., contract, holidayPolicy) pass through directly
            if (
              typeof val === "object" &&
              val !== null &&
              !Array.isArray(val)
            ) {
              cleaned[key] = val;
              continue;
            }

            // if this field is a ref, and it's not already a valid ObjectId…
            // Try both namespaces for refModel
            const refModel =
              mdb.REST?.[schema[key]?.ref] || mdb.INTERNAL?.[schema[key]?.ref];
            if (
              schema[key]?.ref &&
              typeof val === "string" &&
              !mongoose.Types.ObjectId.isValid(val)
            ) {
              // try to find the doc by UUID
              const candidate = await refModel
                .findOne({ uuid: val })
                .select("_id")
                .lean();
              if (candidate) {
                cleaned[key] = candidate._id;
                continue;
              }
            }

            // otherwise just use it as-is
            cleaned[key] = val;
          }

          // 3) actually update, dropping any undefined keys
          const updated = await Model.findOneAndUpdate(
            { uuid: req.params.uuid },
            cleaned,
            { new: true, runValidators: true, omitUndefined: true },
          );
          // Hook: update holiday accruals when updating attendance for an employee
          if (modelName === "attendance" && updated) {
            await holidayAccrualService.updateAccrualFromAttendance(updated);
          }
          // Hook: sync parent vehicle when updating sub-model records
          if (updated) await syncVehicleFromSubModel(modelName, updated);
          res.redirect(`/${modelName}s`);
        } catch (err) {
          logger.error(`❌ Error updating ${modelName}: ${err.message}`);
          next(err);
        }
      };
    }
    if (!denyGuard(config, "d")) {
      // DELETE
      crudController[`delete${baseName}`] = async (req, res, next) => {
        if (req.method === "GET") {
          try {
            const item = await Model.findOne({ uuid: req.params.uuid }).lean();
            if (!item)
              return res.status(404).render(path.join("mongoose", "error"));

            // Build schema and reference data for read-only field rendering
            const schema = extractSchema(Model, config);
            const referenceData = await fetchReferenceData(schema, config, {
              skipFilters: true,
            });

            return res.render(
              path.join("tailwindcss", "partials", "form-delete"),
              {
                title: `Delete ${config.title || baseName}`,
                item,
                schema,
                referenceData,
                basePath: modelName,
                cancelUrl: `/${modelName}s`,
                formAction: `/${modelName}/${item.uuid}/delete`,
                listControllerConfig: listControllerConfig[modelName] || {},
                config,
              },
            );
          } catch (err) {
            logger.error(
              `❌ Error preparing delete for ${modelName}: ${err.message}`,
            );
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
}

module.exports = crudController;
