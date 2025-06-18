module.exports = (sequelize, DataTypes) => {
    const KF_Projects = sequelize.define('KF_Projects', {
        uuid: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            allowNull: false,
        },
        ID: {
            type: DataTypes.INTEGER,
            unique: true,
            allowNull: false,
        },
        Number: DataTypes.INTEGER,
        Name: DataTypes.STRING,
        Reference: DataTypes.STRING,
        Description: DataTypes.TEXT,
        Date1: DataTypes.DATE,
        Date2: DataTypes.DATE,
        CustomerID: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        Status: DataTypes.INTEGER,
        Value: DataTypes.DECIMAL(10, 2),
    }, {
        tableName: 'KF_Projects',
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
    });

    KF_Projects.associate = (models) => {
        KF_Projects.belongsTo(models.KF_Customers, {
            foreignKey: 'CustomerID',
            as: 'customer',
        });
    };

    return KF_Projects;
};
