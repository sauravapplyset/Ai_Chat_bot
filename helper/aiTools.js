// helper/aiTools.js
// AI tools (PDF Summarizer, Text Summarizer, Spell Checker) on the OpenAI Responses API.
// The Assistants API (threads / runs / asst_ ids) was shut down on 26 Aug 2026, so:
//   - a "thread" is now an OpenAI conversation (conv_...), which remembers earlier
//     messages the same way; the app keeps sending it as threadId
//   - a run is one /v1/responses call (no polling)
//   - a tool runs on its prompt (pmpt_...) set as Assistant ID in AI Tools in the admin panel;
//     the instructions live in that prompt in the OpenAI dashboard, none in this code

const axios = require("axios");
const { Op } = require("sequelize");
const Model = require("../model/aiModel.model");
const AiTool = require("../model/aitoolModel");

const OPENAI = "https://api.openai.com/v1";
const TIMEOUT_MS = 120 * 1000;

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

// models row (key + model name) for a tool: the tool's own model, else the first OpenAI model.
// The admin panel saves a tool's model by its display name (modelName, e.g. "GPT-4o mini"),
// so both columns are matched. Active rows first, so a model still being tested never
// supplies the key for live traffic.
const modelRow = async (model) => {
    const order = [["isActive", "DESC"], ["id", "ASC"]];
    let row = model
        ? await Model.findOne({ where: { modelType: "openAi", [Op.or]: [{ model }, { modelName: model }] }, order })
        : null;
    if (!row) row = await Model.findOne({ where: { modelType: "openAi" }, order });
    return row ? row.dataValues : null;
};

/**
 * Model, key and prompt of a tool (hashId from AI Tools). Without a hashId only the key of the
 * first OpenAI model is known (enough for /threadCreate). Returns null when a hashId is given
 * but no active tool has it. promptId is null when the tool's Assistant ID is not a pmpt_ id.
 */
const resolveTool = async (hashId, user) => {
    let tool = null;
    if (hashId) {
        tool = await AiTool.findOne({ where: { isActive: 1, hashId } });
        if (!tool) return null;
        tool = tool.dataValues;
    }
    const row = await modelRow(tool?.model);
    if (!row) return null;
    const assistantId = String(tool?.assistantId || "").trim();
    return {
        name: tool?.nameAssistant || "",
        model: row.model,
        token: user?.isSubscribe == 1 ? row.proToken || row.token : row.token,
        promptId: assistantId.startsWith("pmpt_") ? assistantId : null,
        reduceToken: tool?.reduceToken,
    };
};

// Reply text of a Responses API call (reasoning models put a "reasoning" item before the message)
const replyText = (data) =>
    data.output_text ||
    (data.output || []).find((o) => o.type === "message")?.content?.find((c) => c.type === "output_text")?.text ||
    "";

/**
 * One answer from the tool's prompt. content: Responses API input parts (input_text / input_file).
 * conversation: conv_ id to continue (optional). Retries once per known recoverable error:
 *  - the admin model is rejected by the prompt's saved settings (a prompt saved with a reasoning
 *    model rejects e.g. GPT-4o mini: "reasoning.* is not supported with this model")
 *    → the prompt's own model answers
 *  - the conversation is not found with this tool's key (it was created with another key)
 *    → answered without it (no earlier context) rather than failing
 */
const respond = async (tool, content, conversation) => {
    const payload = { model: tool.model, prompt: { id: tool.promptId }, input: [{ role: "user", content }] };
    if (conversation) payload.conversation = conversation;

    for (let attempt = 0; ; attempt++) {
        try {
            const res = await axios.post(`${OPENAI}/responses`, payload, { headers: headers(tool.token), timeout: TIMEOUT_MS });
            return replyText(res.data);
        } catch (error) {
            const status = error.response?.status;
            const err = error.response?.data?.error || {};
            if (attempt < 2 && status === 400 && payload.model && /^reasoning/.test(err.param || "")) {
                console.log(`[aiTools] ${tool.name}: model ${tool.model} rejected by prompt ${tool.promptId} (${err.message}); using the prompt's model`);
                delete payload.model;
                continue;
            }
            if (attempt < 2 && status === 404 && payload.conversation && /conversation/i.test(`${err.param} ${err.message}`)) {
                console.log(`[aiTools] ${tool.name}: conversation ${payload.conversation} not found (${err.message}); answering without it`);
                delete payload.conversation;
                continue;
            }
            throw error;
        }
    }
};

// New conversation (replaces POST /v1/threads); returns its id (conv_...)
const createConversation = async (token) => {
    const res = await axios.post(`${OPENAI}/conversations`, {}, { headers: headers(token), timeout: TIMEOUT_MS });
    return res.data.id;
};

// Assistant replies of a conversation, newest first (same order the old thread messages had)
const assistantMessages = async (token, conversation) => {
    const res = await axios.get(`${OPENAI}/conversations/${encodeURIComponent(conversation)}/items`, {
        headers: headers(token),
        params: { order: "desc", limit: 100 },
        timeout: TIMEOUT_MS,
    });
    return (res.data.data || [])
        .filter((item) => item.type === "message" && item.role === "assistant")
        .map((item) => ({ role: "assistant", text: item.content?.find((c) => c.type === "output_text")?.text || "" }));
};

// Upload a PDF so a response can read it (input_file)
const uploadFile = async (token, form) => {
    const res = await axios.post(`${OPENAI}/files`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        maxBodyLength: Infinity,
        timeout: TIMEOUT_MS,
    });
    return res.data.id;
};

// App message parts ({ type: "text", text }) → Responses API input parts
const textParts = (content) =>
    (Array.isArray(content) ? content : [{ text: content }])
        .map((c) => (typeof c === "string" ? c : c?.text))
        .filter((t) => typeof t === "string" && t.trim())
        .map((text) => ({ type: "input_text", text }));

module.exports = { resolveTool, respond, createConversation, assistantMessages, uploadFile, textParts };
