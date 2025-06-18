// models/vehicleReceipts.js
module.exports = (sequelize, DataTypes) => {
  const VehicleReceipts = sequelize.define('VehicleReceipts', {
    id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    vehicleId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    date: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    fuelType: {
      type: DataTypes.ENUM('Petrol', 'Diesel'),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.FLOAT,
      allowNull: false,
      validate: {
        min: 0,
      },
    },
    pricePerUnit: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    totalCost: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.0,
      validate: {
        min: 0,
      },
    },
    supplier: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    timestamps: true,
      paranoid: true,
      charset: 'latin1',
      collate: 'latin1_bin',
  });

  VehicleReceipts.associate = (db) => {
    // VehicleReceipts -> Vehicles
    VehicleReceipts.belongsTo(db.Vehicles, { foreignKey: 'vehicleId', allowNull: false });

    // VehicleReceipts -> Employees
    VehicleReceipts.belongsTo(db.Employees, { foreignKey: 'employeeId', allowNull: false });
  };

  return VehicleReceipts;
};
