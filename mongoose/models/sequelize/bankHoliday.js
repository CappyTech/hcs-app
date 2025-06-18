module.exports = (sequelize, DataTypes) => {
    const BankHoliday = sequelize.define('BankHoliday', {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
            allowNull: false,
        },
        title: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
        },
        notes: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        bunting: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
        },
        division: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    }, {
        tableName: 'BankHoliday',
        timestamps: true,
        paranoid: false,
        charset: 'latin1',
        collate: 'latin1_bin',
    });

    return BankHoliday;
};