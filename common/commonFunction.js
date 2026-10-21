const CryptoJS = require("crypto-js");
const axios = require("axios");
const { getToken, getModelToken } = require("../config/manageToken");
const Model = require("../model/aiModel.model");
const appSettings = require("../helper/appSettings");
const path = require('path');
const fs = require('fs/promises');

exports.uniqueNumber = async (type) => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let preFix = ``
    for (let i = 0; i < 10; i++) {
        preFix += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    var newString = ""
    switch (type) {
        case "user":
            newString = `us${preFix}`

            break;

        default:
            break;
    }
    return newString;
}

exports.encrypt = async (text) => {
    const ciphertext = await CryptoJS.AES.encrypt(text, process.env.SECRET_KEY).toString();
    return ciphertext;
};

exports.decrypt = async (text) => {
    const bytes = await CryptoJS.AES.decrypt(text, process.env.SECRET_KEY);
    const originalText = await bytes.toString(CryptoJS.enc.Utf8);
    return originalText;
};

// Sexual score from which a message is refused (admin panel: Content Check)
const sexualThreshold = () => {
    const t = Number(appSettings.get("moderation.sexualThreshold"));
    return t > 0 && t <= 1 ? t : Number(appSettings.DEFAULTS["moderation.sexualThreshold"]);
};

// OpenAI key for the moderation API: the Free key of the model chosen in the admin
// panel, otherwise the first active OpenAI model (as before)
const moderationKey = async () => {
    const id = Number(appSettings.get("moderation.keyModelId"));
    if (id) {
        const row = await Model.findOne({ where: { id } });
        if (row && row.dataValues.token) return row.dataValues.token;
    }
    return (await getModelToken("openAi")).token;
};

// Moderation URL from the admin panel. The OpenAI key goes with it, so anything that is
// not https on an allowed host falls back to the default instead of leaking the key.
const moderationUrl = () => {
    const url = appSettings.get("moderation.url");
    try {
        const u = new URL(url);
        if (u.protocol === "https:" && appSettings.MODERATION_HOSTS.includes(u.hostname.toLowerCase())) return url;
    } catch (e) {}
    console.error(`Moderation URL not allowed, using default: ${url}`);
    return appSettings.DEFAULTS["moderation.url"];
};

// Moderation result for one text: { flagged, categories, category_scores }
const moderate = async (text) => {
    const response = await axios.post(
        moderationUrl(),
        { model: appSettings.get("moderation.model"), input: text },
        {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${await moderationKey()}`,
            },
            timeout: 10000,
        }
    );
    return response.data.results[0];
};

// Any flagged content, or a sexual score at the threshold (assistants, thirdparty routes)
exports.checkModeration = async (text) => {
    try {
        const result = await moderate(text);
        return !!(result.flagged || Number(Number(result.category_scores?.sexual || 0).toFixed(2)) >= sexualThreshold());
    } catch (error) {
        console.error("Error running moderation:", error.response?.data || error.message);
    }
}

// Sexual content only (used by the chat route, where violence etc. in normal questions
// must not be blocked). Fails open: a moderation outage never blocks users.
exports.checkSexualContent = async (text) => {
    try {
        const result = await moderate(text);
        return !!(result.categories?.sexual || result.categories?.["sexual/minors"] || Number(result.category_scores?.sexual || 0) >= sexualThreshold());
    } catch (error) {
        console.error("Error running moderation:", error.response?.data || error.message);
        return false;
    }
}

exports.clearUploadsDir = async () => {
    try {
        const uploadsDir = path.join(process.cwd(), 'public/uploads');
        const files = await fs.readdir(uploadsDir);

        await Promise.all(
            files.map(file =>
                fs.rm(
                    path.join(uploadsDir, file),
                    { recursive: true, force: true }
                )
            )
        );

        console.log('Uploads directory cleared');
    } catch (err) {
        console.error('Failed to clear uploads directory:', err);
    }
}