module.exports = (sequelize, DataTypes) => {
    const KF_Meta = sequelize.define(
      'KF_Meta',
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        model: {
          type: DataTypes.STRING,
          allowNull: false,
        },
        createdCount: {
          type: DataTypes.INTEGER,
          defaultValue: 0,
        },
        updatedCount: {
          type: DataTypes.INTEGER,
          defaultValue: 0,
        },
        lastFetchedAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
      },
      {
        tableName: 'KF_Meta',
        timestamps: true,
      }
    );
  
    return KF_Meta;
  };
  