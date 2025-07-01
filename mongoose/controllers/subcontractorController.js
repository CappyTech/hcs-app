const path = require('path');
const mdb = require('../services/mongooseDatabaseService');

exports.renderChangeSupplierForm = async (req, res, next) => {
  try {
    const supplier = await mdb.supplier.findOne({ uuid: req.params.uuid }).lean();
    if (!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }
    res.render(path.join('mongoose', 'supplier', 'changeSupplier'), {
      title: 'Change Supplier',
      supplier
    });
  } catch (error) {
    next(error);
  }
};

exports.changeSupplier = async (req, res, next) => {
  try {
    const { subcontractor, cisRate, cisNumber } = req.body;

    await mdb.supplier.updateOne(
      { uuid: req.params.uuid },
      {
        $set: {
          Subcontractor: !!subcontractor,
          IsSubcontractor: !!subcontractor,
          CISRate: cisRate,
          CISNumber: cisNumber || null
        }
      }
    );

    return res.redirect('/suppliers');
  } catch (error) {
    next(error);
  }
};
