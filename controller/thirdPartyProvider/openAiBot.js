const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash");
const commonFunction = require("../../common/commonFunction");
const { sendError, sendProviderError } = require("../../helper/statusCodes");
const { resolveTool, respond, textParts } = require("../../helper/aiTools");

const USER_FIELDS = ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'];

// Text Summarizer, Spell Checker and any other text tool.
// hashId (or id): tool in AI Tools in the admin panel; it runs on the tool's prompt (pmpt_).
// threadId: conversation from /threadCreate (optional). type is only a label for token history.

exports.aiBot = async (req, res) => {
    try {
        const { type, role, content, deviceId } = req.body;
        // The app sends the tool as hashId (older clients as id)
        const id = req.body.hashId || req.body.id;
        // Old thread_ ids (Assistants API) no longer exist; only conversations (conv_) carry context
        const threadId = req.body && /^conv_/.test(req.body.threadId || "") ? req.body.threadId : "";
        const uniqueId = req.headers['uniqueid'];

        if (!role || !content) {
            return res.status(400).json({
                message: "Invalid Input"
            })
        }

        const userDetails = await checkToken(deviceId)
        if (!(userDetails.reminToken > 0)) {
            return res.status(400).json({
                message: "Your Quota is Over"
            })
        }
        // A tool runs only on its prompt: no hashId, unknown/inactive tool or an Assistant ID
        // that is not a pmpt_ id is refused
        const tool = id ? await resolveTool(id, userDetails) : null;
        if (!tool || !tool.promptId) {
            console.log(`[thirdparty/aibot] ❌ No prompt for tool ${id || "(no hashId)"}${tool ? ` (${tool.name}: Assistant ID is not pmpt_)` : ""}`);
            return sendError(res, "ASSISTANT_NOT_FOUND");
        }

        const input = textParts(content);
        if (input.length == 0) {
            return sendError(res, "MESSAGE_MISSING");
        }
        for (const item of input) {
            const checkStatus = await commonFunction.checkModeration(item.text);
            if (checkStatus) {
                return sendError(res, "SEXUAL_CONTENT", { text: item.text });
            }
        }

        try {
            const text = await respond(tool, input, threadId || undefined);

            // Charged only once OpenAI has answered
            await reduceToken(deviceId, uniqueId, "Bot", type || tool.name, true)

            const updateUserData = await checkToken(deviceId)
            res.status(200).json({
                data: {
                    id: threadId,
                    content: [{ role: "assistant", text }],
                    userDetails: pick(updateUserData, USER_FIELDS)
                }
            })
        } catch (error) {
            sendProviderError(res, error, "[thirdparty/aibot]");
        }
    } catch (error) {
        console.log("---error---", error)
        res.status(500).json({
            message: "Something went wrong",
            status: 500
        })
    }
};
