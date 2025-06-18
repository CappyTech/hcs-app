const path = require('path');
const moment = require('moment');
const mdb = require('../services/mongooseDatabaseService');

exports.listSuppliers = async (req, res, next) => {
  try {
    const suppliers = await mdb.supplier.find().sort({ Created: -1 }).lean();
    const totalSuppliers = suppliers.length;

    const suppliersWithContact = suppliers.filter(
      s => s.Email || s.Mobile || s.Telephone
    ).length;

    const recentSuppliers = suppliers.filter(
      s => s.Created && moment(s.Created).isAfter(moment().subtract(30, 'days'))
    ).length;

    res.render(path.join('mongoose', 'supplier'), {
      title: 'Suppliers',
      suppliers,
      totalSuppliers,
      suppliersWithContact,
      recentSuppliers
    });
  } catch (error) {
    next(error);
  }
};

exports.viewSupplier = async (req, res, next) => {
  try {
    const supplier = await mdb.supplier.findOne({ uuid: req.params.uuid }).lean();
    if (!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }
    const receipts = await mdb.receipt.find({ CustomerID: supplier.SupplierID }).lean();
    res.render(path.join('mongoose', 'viewSupplier'), {
      title: 'Supplier Overview',
      supplier,
      receipts
    });
  } catch (error) {
    next(error);
  }
};


exports.renderChangeSupplierForm = async (req, res, next) => {
  try {
    const supplier = await mdb.supplier.findOne({ uuid: req.params.uuid }).lean();
    if (!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/suppliers');
    }
    res.render(path.join('mongoose', 'updateSupplier'), {
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
