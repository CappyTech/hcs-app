module.exports = (sequelize, DataTypes) => {
    const KF_Suppliers = sequelize.define('KF_Suppliers', {
        uuid: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            allowNull: false,
        },
        SupplierID: {
            type: DataTypes.INTEGER,
            unique: true,
            allowNull: false,
        },
        Code: DataTypes.STRING,
        Name: DataTypes.STRING,
        Contact: DataTypes.STRING,
        Mobile: DataTypes.STRING,
        Fax: DataTypes.STRING,
        Address1: DataTypes.STRING,
        Address2: DataTypes.STRING,
        Address3: DataTypes.STRING,
        Address4: DataTypes.STRING,
        PostCode: DataTypes.STRING,
        Telephone: DataTypes.STRING,
        Website: DataTypes.STRING,
        Email: DataTypes.STRING,
        Created: DataTypes.DATE,
        Updated: DataTypes.DATE,
        EC: DataTypes.FLOAT,
        VATNumber: DataTypes.STRING,
        Notes: DataTypes.TEXT,
        CurrencyID: DataTypes.INTEGER,
        PaymentTerms: DataTypes.INTEGER,
        ContactTitle: DataTypes.STRING,
        ContactFirstName: DataTypes.STRING,
        ContactLastName: DataTypes.STRING,
        TradeBorderType: DataTypes.INTEGER,
        Subcontractor: DataTypes.BOOLEAN,
        CISRate: {
            type: DataTypes.ENUM('0.3', '0.2', '0'),
            allowNull: false,
            defaultValue: '0.3'
        },
        CISNumber: {
            type: DataTypes.STRING,
            allowNull: true
        }
    }, {
        tableName: 'KF_Suppliers',
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
    });
    
    KF_Suppliers.associate = (models) => {
        KF_Suppliers.hasMany(models.KF_Receipts, {
            foreignKey: 'CustomerID', // Or 'SupplierID' if you rename it
            sourceKey: 'SupplierID',  // Correctly points to SupplierID
            as: 'receipts',
        });
    }

    return KF_Suppliers;
};
