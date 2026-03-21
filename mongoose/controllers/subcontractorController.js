const path = require("path");
const mdb = require("../services/mongooseDatabaseService");

/**
 * GET /subcontractor/assign
 * Renders a form to pick a non-subcontractor supplier and assign them.
 */
exports.renderAssignForm = async (req, res, next) => {
  try {
    // OLD: .find({ IsSubcontractor: { $ne: true } })
    // NEW: non-subcontractors have WithholdingTaxRate null or -1 (not set)
    const suppliers = await mdb.REST.supplier
      .find({ $or: [{ WithholdingTaxRate: null }, { WithholdingTaxRate: { $exists: false } }, { WithholdingTaxRate: -1 }] })
      .sort({ Name: 1 })
      .select("uuid Name Code")
      .lean();

    res.render(path.join("tailwindcss", "supplier", "assignSubcontractor"), {
      title: "Assign Subcontractor",
      suppliers,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /subcontractor/assign
 * Redirects to the change form for the selected supplier.
 */
exports.assignSubcontractor = async (req, res, next) => {
  try {
    const { supplierUuid } = req.body;
    if (!supplierUuid) {
      req.flash("error", "Please select a supplier.");
      return res.redirect("/subcontractor/assign");
    }

    const supplier = await mdb.REST.supplier
      .findOne({ uuid: supplierUuid })
      .lean();
    if (!supplier) {
      req.flash("error", "Supplier not found.");
      return res.redirect("/subcontractor/assign");
    }

    return res.redirect(`/supplier/change/${supplierUuid}`);
  } catch (error) {
    next(error);
  }
};

exports.renderChangeSupplierForm = async (req, res, next) => {
  try {
    const supplier = await mdb.REST.supplier
      .findOne({ uuid: req.params.uuid })
      .lean();
    if (!supplier) {
      req.flash("error", "Supplier not found.");
      return res.redirect("/suppliers");
    }
    res.render(path.join("tailwindcss", "supplier", "changeSupplier"), {
      title: "Change Supplier",
      supplier,
    });
  } catch (error) {
    next(error);
  }
};

exports.changeSupplier = async (req, res, next) => {
  try {
    // OLD: const { subcontractor, cisRate, cisNumber } = req.body;
    const { withholdingTaxRate } = req.body;

    // Parse rate: 0, 0.2, 0.3 are valid subcontractor rates; -1 means not a subcontractor
    const parsedRate = withholdingTaxRate != null && withholdingTaxRate !== '' ? Number(withholdingTaxRate) : -1;

    // Parse references: array of { Name, Value } objects from individual form fields
    const parsedRefs = [];
    for (let i = 0; i < 10; i++) {
      const name = req.body[`whtRefName_${i}`];
      const value = req.body[`whtRefValue_${i}`];
      if (name && value && value.trim()) {
        parsedRefs.push({ Name: name, Value: value.trim() });
      }
    }

    await mdb.REST.supplier.updateOne(
      { uuid: req.params.uuid },
      {
        $set: {
          // OLD SOAP fields — commented out
          // Subcontractor: !!subcontractor,
          // IsSubcontractor: !!subcontractor,
          // CISRate: cisRate,
          // CISNumber: cisNumber || null,
          WithholdingTaxRate: parsedRate,
          WithholdingTaxReferences: parsedRefs.length > 0 ? parsedRefs : null,
        },
      },
    );

    return res.redirect("/suppliers");
  } catch (error) {
    next(error);
  }
};
