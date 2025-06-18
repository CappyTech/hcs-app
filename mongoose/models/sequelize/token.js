module.exports = (sequelize, DataTypes) => {
    const Token = sequelize.define(
        'Token',
        {
            token: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true,
            },
            valid: {
                type: DataTypes.BOOLEAN,
                defaultValue: true,
            },
            action: {
                type: DataTypes.STRING, // Example: 'createForm'
                allowNull: false,
            },
            actionCompleted: {
                type: DataTypes.BOOLEAN,
                defaultValue: false,
            },
        },
        {
            timestamps: true, // Enable createdAt, updatedAt
            paranoid: true,   // Enable soft deletion
            charset: 'latin1',
            collate: 'latin1_bin',
        }
    );

    return Token;
};