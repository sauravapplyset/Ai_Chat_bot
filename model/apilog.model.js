const { DataTypes } = require('sequelize');
const sequelize = require('../db/connection');

const apiLog = sequelize.define('apiLogs', {
    deviceId: {
        allowNull: false,
        type: DataTypes.STRING
    },
    method: {
        allowNull: false,
        type: DataTypes.STRING
    },
    url: {
        allowNull: false,
        type: DataTypes.STRING
    },
    statusCode: {
        allowNull: false,
        type: DataTypes.INTEGER
    },
    body: {
        allowNull: false,
        type: DataTypes.JSON
    },
    responseTimeMs: {
        allowNull: false,
        type: DataTypes.STRING
    },
    cpuUserTimeMs: {
        allowNull: false,
        type: DataTypes.STRING
    },
    cpuSystemTimeMs: {
        allowNull: false,
        type: DataTypes.STRING
    },
    // Reason for an error response (helper/statusCodes.js), e.g. MODEL_BILLING_OVER
    errorKey: {
        allowNull: true,
        type: DataTypes.STRING(64)
    },
}, {
    tableName: 'apiLogs',
    // errorKey is written only when set, so logging keeps working before the column exists
    omitNull: true
});

module.exports = apiLog;