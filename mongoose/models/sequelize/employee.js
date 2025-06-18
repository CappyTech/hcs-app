// models/employees.js
module.exports = (sequelize, DataTypes) => {
  const Employees = sequelize.define('Employees', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true,
      validate: {
        isEmail: true,
      },
    },
    phoneNumber: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    contactName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    contactNumber: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    position: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    type: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    managerId: {
      type: DataTypes.CHAR(36),
      allowNull: true,
    },
    hireDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    hourlyRate: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0.0,
    },
    dailyRate: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
  }, {
    timestamps: true,
    paranoid: true,
    charset: 'latin1',
    collate: 'latin1_bin',
  });

  Employees.associate = (db) => {
    // Employees -> Attendances
    Employees.hasMany(db.Attendances, { foreignKey: 'employeeId', allowNull: false });

    // Employees -> managerId (self-association)
    Employees.hasMany(db.Employees, { foreignKey: 'managerId', allowNull: true });
  };

  return Employees;
};