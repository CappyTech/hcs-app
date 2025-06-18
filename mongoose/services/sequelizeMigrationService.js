// services/sequelizeMigrationService.js
require('dotenv').config();
const { Sequelize, DataTypes } = require('sequelize');
const logger = require('../../services/loggerService');

const sequelize = new Sequelize(
  process.env.MigrateDB_DATABASE,
  process.env.MigrateDB_USER,
  process.env.MigrateDB_PASSWORD,
  {
    host: process.env.MigrateDB_HOST,
    dialect: 'mariadb',
    logging: process.env.DEBUG ? console.log : false,
    dialectOptions: {
      charset: 'utf8mb4',
    },
  }
);

// Load and define only the required models
const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

// Register models manually (minimal example — extend as needed)
db.Users = require('../../models/sequelize/user')(sequelize, DataTypes);
db.Employees = require('../../models/sequelize/employee')(sequelize, DataTypes);
db.Attendances = require('../../models/sequelize/attendance')(sequelize, DataTypes);
db.Locations = require('../../models/sequelize/location-notused')(sequelize, DataTypes);

// Define associations (manually if not already defined in the models)
Object.values(db).forEach(model => {
  if (model.associate) model.associate(db);
});

module.exports = db;
