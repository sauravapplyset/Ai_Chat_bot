const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash");
const commonFunction = require("../../common/commonFunction");
const { sendError, sendProviderError } = require("../../helper/statusCodes");
const { resolveTool, respond, textParts } = require("../../helper/aiTools");

const USER_FIELDS = ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'];

// type
//     summarizerBot
//     spellCheckerBot
// id: tool hashId (AI Tools in the admin panel); threadId: conversation from /threadCreate (optional)

exports.aiBot = async (req, res) => {
    try {
        const { type, role, content, deviceId, id } = req.body;
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
        const tool = await resolveTool(id, userDetails);
        if (!tool) {
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

        const kind = type === "spellCheckerBot" || /spell/i.test(tool.name) ? "spellChecker" : "summarizer";

        // Spell Checker: mark the text as the thing to check, so a text that reads like a
        // question is corrected instead of answered
        const toolInput = kind === "spellChecker" && !tool.promptId
            ? input.map((p) => ({ type: "input_text", text: `Check this text:\n"""\n${p.text}\n"""` }))
            : input;

        try {
            const text = await respond(tool, kind, toolInput, threadId || undefined);

            // Charged only once OpenAI has answered
            await reduceToken(deviceId, uniqueId, "Bot", type || kind, true)

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
