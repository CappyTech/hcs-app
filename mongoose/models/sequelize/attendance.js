module.exports = (sequelize, DataTypes) => {
    const Attendances = sequelize.define('Attendances', {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            allowNull: false,
        },
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            validate: {
                isDate: true,
            }
        },
        type: {
            type: DataTypes.ENUM('off', 'holiday', 'sick', 'work', 'training', 'leave'),
            defaultValue: 'work',
            allowNull: false,
        },
        locationId: {
            type: DataTypes.UUID,
            allowNull: true,
        },
        projectId: {
            type: DataTypes.UUID,
            allowNull: true,
        },
        employeeId: {
            type: DataTypes.UUID,
            allowNull: true, 
        },
        subcontractorId: {
            type: DataTypes.UUID,
            allowNull: true,
        },
        hoursWorked: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            validate: {
                min: 0,
            }
        },
        payRate: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            validate: {
                min: 0,
            }
        },
        dayRate: {
            type: DataTypes.DECIMAL(10, 2),
            allowNull: true,
            validate: {
                min: 0,
            }
        },
    }, {
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
        indexes: [
            { fields: ['date'] },
            { fields: ['employeeId'] },
            { fields: ['subcontractorId'] },
            { fields: ['locationId'] }
        ],
        validate: {
            onlyOnePersonType() {
                if (this.employeeId && this.subcontractorId) {
                    throw new Error("An attendance record can only belong to either an employee or a subcontractor, not both.");
                }
                if (!this.employeeId && !this.subcontractorId) {
                    throw new Error("An attendance record must belong to either an employee or a subcontractor.");
                }
            },
            enforcePayRateOrDayRate() {
                if (this.hoursWorked && this.dayRate) {
                    throw new Error("An attendance record should have either hoursWorked or a dayRate, but not both.");
                }
            },
            onlyOneLocationOrProject() {
                if (this.locationId && this.projectId) {
                    throw new Error("An attendance record can only have a locationId OR a projectId, not both.");
                }
                if (!this.locationId && !this.projectId) {
                    throw new Error("An attendance record must have either a locationId OR a projectId.");
                }
            }
        }
    });
/*
    Attendances.associate = (db) => {
        // Attendances -> Employees
        db.Attendances.belongsTo(db.Employees, { foreignKey: 'employeeId' });
        db.Employees.hasMany(db.Attendances, { foreignKey: 'employeeId' });

        // Attendances -> Subcontractors
        db.Attendances.belongsTo(db.Subcontractors, { foreignKey: 'subcontractorId' });
        db.Subcontractors.hasMany(db.Attendances, { foreignKey: 'subcontractorId' });

        // Attendances -> Locations
        db.Attendances.belongsTo(db.Locations, { foreignKey: 'locationId' });
        db.Locations.hasMany(db.Attendances, { foreignKey: 'locationId' });
    };
*/
    return Attendances;
};
