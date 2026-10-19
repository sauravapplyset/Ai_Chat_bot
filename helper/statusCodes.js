// helper/statusCodes.js
// Every error the app can get comes from here. Admins edit the HTTP status and
// message per error in the admin panel (apiStatusCodes table); this file only
// holds the defaults, which are exactly what the app received before, so the
// app needs no change.
//
// The table is read into memory and refreshed every minute; it is never queried
// per request. If the DB is unavailable the defaults below are used.
//
// Response shape is unchanged: { message } or { message, status } with the same
// HTTP status code. The error key (e.g. MODEL_BILLING_OVER) is only stored in
// apiLogs.errorKey so admins can filter by it; it is not sent to the app.

const { QueryTypes } = require("sequelize");
const sequelize = require("../db/connection");

const TABLE = "apiStatusCodes";
const REFRESH_MS = 60 * 1000;

// key -> { httpStatus, message, title, matchPattern, withStatus }
// withStatus: the original response also had a "status" field
const DEFAULTS = {
    USER_QUOTA_OVER: {
        title: "User tokens finished",
        httpStatus: 400,
        message: "Your Quota is Over",
        matchPattern: null,
    },
    MODEL_BILLING_OVER: {
        title: "AI provider billing / credits over",
        // 205 so admins can spot "our OpenAI / Gemini balance is finished" in the API Logs.
        // Express sends no body with 205, so the app gets an empty response.
        httpStatus: 205,
        message: "This model is temporarily unavailable. Please try again later or choose another model.",
        matchPattern: "insufficient_quota\nbilling_hard_limit_reached\nbilling_not_active\nbilling_disabled\nexceeded your current quota\ncheck your plan and billing\ncredit balance is too low\npayment required\nbilling",
    },
    SEXUAL_CONTENT: {
        title: "Sexual / explicit content",
        // 203 (not 400) so the app and the admin logs can tell this apart from other errors
        httpStatus: 203,
        message: "A \"{text}\" might refer to content that is explicit, sexual, or involves descriptions of nudity. However, sharing or promoting such text is often inappropriate and may violate community guidelines, moral standards, and even laws in some cases.\n\nIf you're using the term in a different context, could you please provide more details to help me better understand what you mean?",
        matchPattern: null,
    },
    CONTENT_POLICY: {
        title: "Blocked by AI provider safety filter",
        httpStatus: 400,
        message: "Your request was blocked by our content policy. Please rephrase it and try again.",
        matchPattern: "content_policy_violation\ncontent_filter\ninvalid_prompt\nprohibited_content\nfinishreason safety",
    },
    MODEL_OVERLOADED: {
        title: "AI provider busy / rate limited",
        httpStatus: 503,
        message: "The model is overloaded. Please try again later.",
        matchPattern: "rate_limit_exceeded\noverloaded\nunavailable\nresource_exhausted\ntoo many requests",
    },
    CONTEXT_TOO_LONG: {
        title: "Chat too long for the model",
        httpStatus: 400,
        message: "This chat is too long. Please start a new chat.",
        matchPattern: "context_length_exceeded\nmaximum context length\ntoo many tokens\nstring_above_max_length",
    },
    PROVIDER_KEY_INVALID: {
        title: "AI provider API key invalid",
        httpStatus: 400,
        message: "This model is temporarily unavailable. Please try again later or choose another model.",
        matchPattern: "invalid_api_key\nincorrect api key\napi key not valid\nunauthenticated\npermission_denied",
    },
    MODEL_NOT_FOUND: {
        title: "Model not found or inactive",
        httpStatus: 400,
        message: "Model Not Found",
        matchPattern: "model_not_found\ndoes not exist or you do not have access",
    },
    ASSISTANT_NOT_FOUND: {
        title: "Assistant not found or inactive",
        httpStatus: 400,
        message: "Assistant Not Found",
        matchPattern: null,
    },
    MESSAGE_MISSING: {
        title: "Message missing in request",
        httpStatus: 400,
        message: "Messages Missing",
        matchPattern: null,
    },
    INVALID_REQUEST: {
        title: "AI provider rejected the request",
        httpStatus: 400,
        message: "Unable to process your request. Please try again.",
        matchPattern: null,
    },
    SERVER_ERROR: {
        title: "Server error",
        httpStatus: 500,
        message: "Something went wrong",
        matchPattern: null,
        withStatus: true,
    },
    TOO_MANY_REQUESTS: {
        title: "Too many requests from one device / IP",
        httpStatus: 429,
        message: "Too many requests, please try again later.",
        matchPattern: null,
    },
};

// Order in which built-in patterns are tried; specific causes before generic ones
const BUILTIN_MATCH_ORDER = [
    "MODEL_BILLING_OVER",
    "PROVIDER_KEY_INVALID",
    "CONTEXT_TOO_LONG",
    "MODEL_NOT_FOUND",
    "CONTENT_POLICY",
    "MODEL_OVERLOADED",
];

let rows = new Map();      // key -> row from DB (system overrides + custom rules)
let customRules = [];      // active non-system rows with a matchPattern, by priority
let loaded = false;

const splitPattern = (p) =>
    String(p || "")
        .split(/\r?\n|,/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

// 2xx is allowed for special cases such as SEXUAL_CONTENT (203)
const validStatus = (s) => Number.isInteger(Number(s)) && Number(s) >= 200 && Number(s) <= 599;

const ensureTable = async () => {
    const [existing] = await sequelize.query(`SHOW TABLES LIKE '${TABLE}'`);
    if (!existing.length) {
        // First rollout: the admin panel used to save every assistant with the fixed
        // placeholder 'gpt-4o-mini', which this API ignored (it always used the default).
        // Mark those as 'default' so they keep running on the default model.
        // The admin panel migration does the same when it creates the table first.
        await sequelize.query("UPDATE `assistant` SET `model` = 'default' WHERE `model` = 'gpt-4o-mini'");
    }
    await sequelize.query(
        `CREATE TABLE IF NOT EXISTS \`${TABLE}\` (
            \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            \`key\` VARCHAR(64) NOT NULL UNIQUE,
            \`title\` VARCHAR(255) NOT NULL,
            \`httpStatus\` SMALLINT UNSIGNED NOT NULL DEFAULT 400,
            \`message\` TEXT NOT NULL,
            \`matchPattern\` TEXT NULL,
            \`priority\` INT NOT NULL DEFAULT 100,
            \`isSystem\` TINYINT(1) NOT NULL DEFAULT 0,
            \`isActive\` TINYINT(1) NOT NULL DEFAULT 1,
            \`createdAt\` DATETIME NULL,
            \`updatedAt\` DATETIME NULL
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    // Insert missing system rows with their defaults; existing rows (admin edits) are kept
    for (const [key, d] of Object.entries(DEFAULTS)) {
        await sequelize.query(
            `INSERT IGNORE INTO \`${TABLE}\` (\`key\`, \`title\`, \`httpStatus\`, \`message\`, \`matchPattern\`, \`priority\`, \`isSystem\`, \`isActive\`, \`createdAt\`, \`updatedAt\`)
             VALUES (?, ?, ?, ?, ?, 100, 1, 1, NOW(), NOW())`,
            { replacements: [key, d.title, d.httpStatus, d.message, d.matchPattern] }
        );
    }
    // Error key per API log row, so the admin panel can filter logs by reason
    const [col] = await sequelize.query("SHOW COLUMNS FROM `apiLogs` LIKE 'errorKey'");
    if (!col.length) {
        await sequelize.query("ALTER TABLE `apiLogs` ADD COLUMN `errorKey` VARCHAR(64) NULL, ADD INDEX `apilogs_errorkey_index` (`errorKey`)");
    }
};

const refresh = async () => {
    const list = await sequelize.query(
        `SELECT \`key\`, \`httpStatus\`, \`message\`, \`matchPattern\`, \`priority\`, \`isSystem\`, \`isActive\` FROM \`${TABLE}\``,
        { type: QueryTypes.SELECT }
    );
    const next = new Map();
    for (const r of list) next.set(r.key, r);
    rows = next;
    customRules = list
        .filter((r) => !r.isSystem && r.isActive && splitPattern(r.matchPattern).length)
        .sort((a, b) => a.priority - b.priority)
        .map((r) => ({ key: r.key, patterns: splitPattern(r.matchPattern) }));
    loaded = true;
};

const init = async () => {
    try {
        await ensureTable();
        await refresh();
        console.log(`[statusCodes] loaded ${rows.size} status codes`);
    } catch (err) {
        console.error("[statusCodes] using built-in defaults, retrying in 1 min:", err.message);
        setTimeout(init, REFRESH_MS).unref();
        return;
    }
    setInterval(() => {
        refresh().catch((err) => console.error("[statusCodes] refresh failed:", err.message));
    }, REFRESH_MS).unref();
};

if (process.env.STATUS_CODES_DB !== "0") init();

// Effective config for a key: admin row (if active and valid) over the default
const get = (key) => {
    const d = DEFAULTS[key] || DEFAULTS.SERVER_ERROR;
    const r = rows.get(key);
    if (!r || !r.isActive) return { key, ...d };
    return {
        key,
        title: d.title,
        withStatus: d.withStatus,
        httpStatus: validStatus(r.httpStatus) ? Number(r.httpStatus) : (d.httpStatus || 400),
        message: r.message && String(r.message).trim() ? String(r.message) : d.message,
    };
};

// Send an error the app understands. vars replace {name} placeholders in the message.
const sendError = (res, key, vars = {}) => {
    const c = get(key);
    res.locals.errorKey = key;
    const message = c.message.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
    const body = c.withStatus ? { message, status: c.httpStatus } : { message };
    return res.status(c.httpStatus).json(body);
};

// Text that describes a provider error (OpenAI / Gemini / Mistral / network)
const errorText = (error) => {
    const data = error?.response?.data;
    const e = data?.error;
    return [
        e?.code, e?.type, e?.status, e?.message, e?.param,
        // Gemini puts the real cause here, e.g. reason BILLING_DISABLED
        Array.isArray(e?.details) && e.details.map((d) => d?.reason).filter(Boolean).join(" "),
        data?.detail && JSON.stringify(data.detail), data?.message, data?.type,
        error?.code, error?.message,
    ]
        .filter((v) => v != null && v !== "")
        .map(String)
        .join(" | ")
        .toLowerCase();
};

// Map a provider error to an error key: admin custom rules first, then admin-edited
// patterns of system keys, then the HTTP status of the provider response.
const classify = (error) => {
    const text = errorText(error);
    const status = error?.response?.status;

    for (const rule of customRules) {
        if (rule.patterns.some((p) => text.includes(p))) return rule.key;
    }
    for (const key of BUILTIN_MATCH_ORDER) {
        const r = rows.get(key);
        const pattern = r && r.isActive && r.matchPattern != null ? r.matchPattern : DEFAULTS[key].matchPattern;
        if (splitPattern(pattern).some((p) => text.includes(p))) return key;
    }
    if (status === 402) return "MODEL_BILLING_OVER";
    if (status === 401 || status === 403) return "PROVIDER_KEY_INVALID";
    if (status === 404) return "MODEL_NOT_FOUND";
    if (status === 429 || status === 503 || status === 529) return "MODEL_OVERLOADED";
    if (status >= 400 && status < 500) return "INVALID_REQUEST";
    return "SERVER_ERROR";
};

// Log the real provider error server-side and answer with the mapped, admin-managed error
const sendProviderError = (res, error, tag = "[provider]") => {
    const key = classify(error);
    console.log(`${tag} ❌ ${key} | HTTP ${error?.response?.status || "-"} | ${errorText(error).slice(0, 500)}`);
    return sendError(res, key);
};

module.exports = { DEFAULTS, get, sendError, sendProviderError, classify, isLoaded: () => loaded };
