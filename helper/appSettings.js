// helper/appSettings.js
// Settings admins change in the admin panel (appSettings table, one row per key).
// The table is read into memory and refreshed every minute; it is never queried
// per request. Until it can be read, the defaults below are used, so the API
// behaves exactly as before.

const { QueryTypes } = require("sequelize");
const sequelize = require("../db/connection");

const TABLE = "appSettings";
const REFRESH_MS = 60 * 1000;

// Same keys and defaults as App\Models\AppSetting::DEFAULTS in the admin panel; keep both in sync
const DEFAULTS = {
    // OpenAI moderation model that checks user text before it reaches the AI
    "moderation.model": "omni-moderation-latest",
    // Sexual score (0-1) from which a message is refused with SEXUAL_CONTENT
    "moderation.sexualThreshold": "0.3",
    // id of the models row whose Free key calls the moderation API; empty = first active OpenAI model
    "moderation.keyModelId": "",
};

let values = new Map();

const ensureTable = () =>
    sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`${TABLE}\` (
            \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            \`key\` VARCHAR(100) NOT NULL UNIQUE,
            \`value\` TEXT NULL,
            \`createdAt\` DATETIME NULL,
            \`updatedAt\` DATETIME NULL
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

const refresh = async () => {
    const list = await sequelize.query(`SELECT \`key\`, \`value\` FROM \`${TABLE}\``, { type: QueryTypes.SELECT });
    values = new Map(list.map((r) => [r.key, r.value]));
};

const init = async () => {
    try {
        await ensureTable();
        await refresh();
        console.log(`[appSettings] loaded ${values.size} settings`);
    } catch (err) {
        console.error("[appSettings] using defaults, retrying in 1 min:", err.message);
        setTimeout(init, REFRESH_MS).unref();
        return;
    }
    setInterval(() => {
        refresh().catch((err) => console.error("[appSettings] refresh failed:", err.message));
    }, REFRESH_MS).unref();
};

if (process.env.APP_SETTINGS_DB !== "0") init();

// Saved value, or the default when it is missing or empty
const get = (key) => {
    const v = values.get(key);
    return v != null && String(v).trim() !== "" ? String(v).trim() : DEFAULTS[key];
};

module.exports = { DEFAULTS, get };
