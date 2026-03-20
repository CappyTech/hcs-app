const path = require("path");
const mdb = require("../services/mongooseDatabaseService");

/**
 * GET /subcontractor/assign
 * Renders a form to pick a non-subcontractor supplier and assign them.
 */
exports.renderAssignForm = async (req, res, next) => {
  try {
    const suppliers = await mdb.REST.supplier
      .find({ IsSubcontractor: { $ne: true } })
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
    const { subcontractor, cisRate, cisNumber } = req.body;

    await mdb.REST.supplier.updateOne(
      { uuid: req.params.uuid },
      {
        $set: {
          Subcontractor: !!subcontractor,
          IsSubcontractor: !!subcontractor,
          CISRate: cisRate,
          CISNumber: cisNumber || null,
        },
      },
    );

    return res.redirect("/suppliers");
  } catch (error) {
    next(error);
  }
};
