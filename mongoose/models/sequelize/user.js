const encryptionService = require('../../services/encryptionService');
const bcrypt = require('bcrypt'); // Ensure bcrypt is imported for password hashing

// Role-Permission Mapping
const rolePermissions = {
    admin: {
        createUser: true,
        readUser: true,
        updateUser: true,
        deleteUser: true,
        createInvoice: true,
        readInvoice: true,
        updateInvoice: true,
        deleteInvoice: true,
        createSubcontractor: true,
        readSubcontractor: true,
        updateSubcontractor: true,
        deleteSubcontractor: true,
        unpaidInvoices: true,
        unsubmittedInvoices: true,
    },
    subcontractor: {
        readInvoice: true,
        createInvoice: true,
    },
    employee: {
        readUser: true,
    },
    accountant: {
        readInvoice: true,
        updateInvoice: true,
    },
    hmrc: {
        readInvoice: true,
    },
};

module.exports = (sequelize, DataTypes) => {
    const Users = sequelize.define('Users', {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        username: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
        },
        email: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
            validate: {
                isEmail: true,
            },
        },
        password: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        role: {
            type: DataTypes.ENUM('subcontractor', 'employee', 'accountant', 'hmrc', 'admin'),
            defaultValue: 'subcontractor',
            allowNull: false,
        },
        permissions: {
            type: DataTypes.JSON,
            allowNull: false,
            defaultValue: {},
            get() {
                // Ensure it always returns a parsed object
                const rawValue = this.getDataValue('permissions');
                return typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
            },
            set(value) {
                // Ensure proper JSON stringification before saving
                this.setDataValue('permissions', value);
            },
        },
        subcontractorId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: {
                model: 'Subcontractors',
                key: 'id',
            }
        },
        clientId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: {
                model: 'Clients',
                key: 'id',
            }
        },
        employeeId: {
            type: DataTypes.UUID,
            allowNull: true,
            references: {
                model: 'Employees',
                key: 'id',
            }
        },
        totpSecret: {
            type: DataTypes.STRING,
            allowNull: true, // Can be null until TOTP is enabled
            set(value) {
                if (value) {
                    this.setDataValue('totpSecret', encryptionService.encrypt(value));
                }
            },
            get() {
                const encrypted = this.getDataValue('totpSecret');
                return encrypted ? encryptionService.decrypt(encrypted) : null;
            }
        },
        totpEnabled: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
        },
    }, {
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
    });
/*
    Users.associate = (db) => {
        // Users -> Clients
        Users.belongsTo(db.Clients, { foreignKey: 'clientId', as: 'Client' });

        // Users -> Employees
        Users.belongsTo(db.Employees, { foreignKey: 'employeeId', as: 'Employee' });

        // Users -> Subcontractor (single subcontractor association)
        Users.belongsTo(db.Subcontractors, { foreignKey: 'subcontractorId', as: 'Subcontractor' });
    };
*/
    // Hook to hash the password before creating the user
    Users.beforeCreate(async (user) => {
        if (user.password) {
            user.password = await bcrypt.hash(user.password, 10);
        }

        // Assign default permissions based on role
        user.permissions = rolePermissions[user.role] || {};

        // Ensure only one of these fields is set at a time
        const count = [user.subcontractorId, user.clientId, user.employeeId].filter(id => id !== null).length;
        if (count > 1) {
            throw new Error('User can only be linked to one of subcontractor, client, or employee.');
        }
    });

    // Hook to hash the password before updating the user
    Users.beforeUpdate(async (user) => {
        if (user.changed('password')) {
            user.password = await bcrypt.hash(user.password, 10);
        }

        // Update permissions if the role changes
        if (user.changed('role')) {
            user.permissions = rolePermissions[user.role] || {};
        }
    });

    return Users;
};

// Export rolePermissions explicitly
module.exports.rolePermissions = rolePermissions;