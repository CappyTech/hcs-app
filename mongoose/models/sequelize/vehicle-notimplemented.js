module.exports = (sequelize, DataTypes) => {
  const Vehicles = sequelize.define('Vehicles', {
    id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    employeeId: {
      type: DataTypes.CHAR(36),
      allowNull: true,
      references: {
        model: 'Employees',
        key: 'id',
      }
    },
    subcontractorId: {
      type: DataTypes.CHAR(36),
      allowNull: true,
      references: {
        model: 'Subcontractors',
        key: 'id',
      }
    },
    make: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    registrationNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },
    color: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    year: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    vin: {
      type: DataTypes.STRING(50),
      allowNull: true,
      unique: true,
    },
    engineNumber: {
      type: DataTypes.STRING(50),
      allowNull: true,
      unique: true,
    },
    fuelType: {
      type: DataTypes.ENUM('Petrol', 'Diesel', 'Electric', 'Hybrid'),
      allowNull: true,
    },
    mileage: {
      type: DataTypes.INTEGER, // Current mileage
      allowNull: true,
    },
    insuranceProvider: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    insurancePolicyNumber: {
      type: DataTypes.STRING(100),
      allowNull: true,
      unique: true,
    },
    insuranceExpiryDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    motExpiryDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    roadTaxExpiryDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    roadTaxAmount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0.0,
    },
    ownershipStatus: {
      type: DataTypes.ENUM('Owned', 'Leased', 'Rented'),
      allowNull: true,
    },
    purchaseDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    leaseExpiryDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    assignedDepartment: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    vehicleUsage: {
      type: DataTypes.ENUM('Passenger Transport', 'Delivery', 'Maintenance', 'Administrative', 'Other'),
      allowNull: true,
    },
    availabilityStatus: {
      type: DataTypes.ENUM('Available', 'In Use', 'Under Maintenance', 'Out of Service'),
      allowNull: true,
    },
  }, {
    timestamps: true,
      paranoid: true,
      charset: 'latin1',
      collate: 'latin1_bin',
  });

  Vehicles.associate = (db) => {
    // Vehicles -> Employees
    Vehicles.belongsTo(db.Employees, { foreignKey: 'employeeId', allowNull: false });

    // Vehicles -> Jobs (if applicable)
    Vehicles.belongsTo(db.Jobs, { foreignKey: 'jobId', allowNull: true });

    // Vehicles -> VehicleChecks
    Vehicles.hasMany(db.VehicleChecks, { foreignKey: 'vehicleId', allowNull: false });

    // Vehicles -> VehicleChecks
    Vehicles.hasMany(db.VehicleReceipts, { foreignKey: 'vehicleId', allowNull: false });
  };

  return Vehicles;
};
