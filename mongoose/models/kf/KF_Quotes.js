module.exports = (sequelize, DataTypes) => {
    const KF_Quotes = sequelize.define('KF_Quotes', {
        uuid: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            allowNull: false,
        },
        InvoiceDBID: {
            type: DataTypes.INTEGER,
            unique: true,
            allowNull: false,
        },
        InvoiceNumber: DataTypes.INTEGER,
        InvoiceDate: DataTypes.DATE,
        DueDate: {
            type: DataTypes.DATE,
            allowNull: true,
            set(value) {
                // Convert placeholder dates to null
                if (value === '0001-01-01T00:00:00.000Z' || value === '0001-01-01T00:01:15.000Z') {
                    this.setDataValue('DueDate', null);
                } else {
                    this.setDataValue('DueDate', value);
                }
            },
            get() {
                const value = this.getDataValue('DueDate');
                return value ? value : null; // Return null for invalid dates
            }
        },
        Customer: DataTypes.STRING,
        CustomerID: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        Paid: DataTypes.DECIMAL(10, 2),
        CustomerReference: DataTypes.STRING,
        EstimateCategory: DataTypes.STRING,
        SuppressTotal: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            get() {
                return this.getDataValue('SuppressTotal') === 1;
            },
            set(value) {
                this.setDataValue('SuppressTotal', value ? 1 : 0);
            },
        },
        ProjectID: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        CurrencyCode: DataTypes.STRING,
        ExchangeRate: DataTypes.DECIMAL(10, 6),
        NetAmount: DataTypes.DECIMAL(10, 2),
        VATAmount: DataTypes.DECIMAL(10, 2),
        AmountPaid: DataTypes.DECIMAL(10, 2),
        CustomerName: DataTypes.STRING,
        PermaLink: DataTypes.STRING,
        DeliveryAddress: {
            type: DataTypes.JSON,
            allowNull: true,
        },
        UseCustomDeliveryAddress: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            get() {
                return this.getDataValue('UseCustomDeliveryAddress') === 1;
            },
            set(value) {
                this.setDataValue('UseCustomDeliveryAddress', value ? 1 : 0);
            },
        },
        CISRCNetAmount: DataTypes.DECIMAL(10, 2),
        CISRCVatAmount: DataTypes.DECIMAL(10, 2),
        IsCISReverseCharge: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            get() {
                return this.getDataValue('IsCISReverseCharge') === 1;
            },
            set(value) {
                this.setDataValue('IsCISReverseCharge', value ? 1 : 0);
            },
        },
        Lines: {
            type: DataTypes.JSON,
            allowNull: true,
            set(value) {
                // Normalize Lines to ensure it is stored as JSON
                if (typeof value === 'string') {
                    try {
                        this.setDataValue('Lines', JSON.parse(value));
                    } catch (error) {
                        this.setDataValue('Lines', null); // Fallback to null on parse error
                    }
                } else {
                    this.setDataValue('Lines', value);
                }
            },
            get() {
                const value = this.getDataValue('Lines');
                return value || []; // Default to empty array if null
            }
        },
        ReadableString: DataTypes.TEXT,
    }, {
        tableName: 'KF_Quotes',
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
    });

    KF_Quotes.associate = (models) => {
        KF_Quotes.belongsTo(models.KF_Customers, {
            foreignKey: 'CustomerID',
            as: 'customer',
        });
    };

    return KF_Quotes;
};
/* 
function mapLine(line) {
    return {
        LineID: line.LineID,
        Quantity: line.Quantity || null,
        Description: line.Description || null,
        Rate: line.Rate || null,
        ChargeType: line.ChargeType || null,
        ChargeTypeName: line.ChargeType ? ChargeTypes[line.ChargeType] || null : null,
        VatRate: line.VatRate || null,
        VatAmount: line.VatAmount || null,
        ProductID: line.ProductID || null,
        Sort: line.Sort || null,
        ProjID: line.ProjID || null,
    };
}    
*/