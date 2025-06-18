module.exports = (sequelize, DataTypes) => {
    const Session = sequelize.define('Session', {
        session_id: {
            type: DataTypes.STRING(128),
            primaryKey: true,
        },
        expires: {
            type: DataTypes.INTEGER.UNSIGNED,
            allowNull: false,
        },
        data: {
            type: DataTypes.TEXT,
            allowNull: true,
        },
    }, {
        tableName: 'sessions', // Matches your existing table name
        timestamps: false, // No `createdAt` or `updatedAt` fields
        charset: 'utf8mb4',
        collate: 'utf8mb4_bin',
    });

    return Session;
};
