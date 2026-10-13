const { DataTypes } = require('sequelize');
const sequelize = require('../db/connection');

// Permanent bans written by middleware/security.js. Read into memory at startup
// and refreshed periodically; never queried per request.
// Delete a row to unban (takes effect within an hour, or on the next deploy).
const SecurityBan = sequelize.define('security_bans', {
    ipKey: {
        type: DataTypes.STRING(64),
        primaryKey: true,
        allowNull: false
    },
    reason: {
        type: DataTypes.STRING(64),
        allowNull: true
    },
    path: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
    userAgent: {
        type: DataTypes.STRING(255),
        allowNull: true
    },
}, {
    tableName: 'security_bans',
    timestamps: true,
    updatedAt: false
});

module.exports = SecurityBan;
