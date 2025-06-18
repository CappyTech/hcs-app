// models/client.js
module.exports = (sequelize, DataTypes) => {
    const Clients = sequelize.define('Clients', {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
    }, {
        timestamps: true,
        paranoid: true,
        charset: 'latin1',
        collate: 'latin1_bin',
    });

    Clients.associate = (db) => {
        // Clients -> Quotes
        db.Clients.hasMany(db.Quotes, { foreignKey: 'clientId', allowNull: false });
        db.Quotes.belongsTo(db.Clients, { foreignKey: 'clientId', allowNull: false });

        // Clients -> Contacts
        db.Clients.hasMany(db.Contacts, { foreignKey: 'clientId', allowNull: false });
        db.Contacts.belongsTo(db.Clients, { foreignKey: 'clientId', allowNull: false });

        // Clients -> Jobs
        db.Clients.hasMany(db.Jobs, { foreignKey: 'clientId', allowNull: false });
        db.Jobs.belongsTo(db.Clients, { foreignKey: 'clientId', allowNull: false });
    };

return Clients;
}
