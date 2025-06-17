const path = require('path');
const db = require('../../services/mongooseDatabaseService');
const logger = require('../../services/loggerService');

// List all customers
exports.listCustomers = async (req, res, next) => {
  try {
    const customers = await db.Customer.find().limit(50);
    res.render(path.join('customers','index'), { title: 'Mongo Customers', customers });
  } catch (error) {
    logger.error('Error listing customers: ' + error.message);
    next(error);
  }
};

// Render create form
exports.renderCreateForm = (req, res) => {
  res.render(path.join('customers','create'), { title: 'Create Customer' });
};

// Create new customer
exports.createCustomer = async (req, res, next) => {
  try {
    const { CustomerID, Name, Telephone, Email } = req.body;
    await db.Customer.create({ CustomerID, Name, Telephone, Email });
    req.flash('success', 'Customer created successfully.');
    res.redirect('/mongo/customers');
  } catch (error) {
    logger.error('Error creating customer: ' + error.message);
    next(error);
  }
};

// Show a single customer
exports.showCustomer = async (req, res, next) => {
  try {
    const customer = await db.Customer.findById(req.params.id);
    if (!customer) {
      return res.status(404).send('Customer not found');
    }
    res.render(path.join('customers','show'), { title: 'Customer Details', customer });
  } catch (error) {
    logger.error('Error fetching customer: ' + error.message);
    next(error);
  }
};
