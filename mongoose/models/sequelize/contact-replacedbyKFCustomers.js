// models/contact.js
module.exports = (sequelize, DataTypes) => {
    const Contacts = sequelize.define('Contacts', {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        clientId: {
            type: DataTypes.UUID,
            allowNull: false,
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        phone: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        email: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        note: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
    }, {
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
    });

    Contacts.associate = (db) => {
        // Contacts -> Clients
        Contacts.belongsTo(db.Clients, { foreignKey: 'clientId', allowNull: false });
    };

    return Contacts;
}
