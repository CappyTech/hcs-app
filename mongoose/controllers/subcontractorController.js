const path = require("path");
const mdb = require("../services/mongooseDatabaseService");

/**
 * GET /subcontractor/assign
 * Renders a form to pick a supplier and edit their CIS details.
 */
exports.renderAssignForm = async (req, res, next) => {
  try {
    // Show all suppliers so any can be edited — not just unassigned ones
    const suppliers = await mdb.REST.supplier
      .find({})
      .sort({ Name: 1 })
      .select("uuid Name Code WithholdingTaxRate")
      .lean();

    res.render(path.join("tailwindcss", "supplier", "assignSubcontractor"), {
      title: "Edit CIS Details",
      suppliers,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /subcontractor/assign
 * Redirects to the CIS edit form for the selected supplier.
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
      title: "Edit CIS Details",
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

    // Parse rate: 0, 20, 30 are valid subcontractor rates (REST whole %); -1 means not a subcontractor
    // Also accept legacy decimal forms 0.2, 0.3
    const allowedRates = [-1, 0, 0.2, 0.3, 20, 30];
    const rawRate = withholdingTaxRate != null && withholdingTaxRate !== '' ? Number(withholdingTaxRate) : -1;
    const parsedRate = allowedRates.includes(rawRate) ? rawRate : -1;

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
