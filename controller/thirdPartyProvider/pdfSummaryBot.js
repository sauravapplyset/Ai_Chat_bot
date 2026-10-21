const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const { sendError, sendProviderError } = require("../../helper/statusCodes");
const { reduceToken } = require("../../helper/common");
const { pick } = require("lodash")
const { checkToken } = require("../../helper/common");
const User = require("../..//model/user.model");
const { resolveTool, respond, createConversation, assistantMessages, uploadFile } = require("../../helper/aiTools");

const USER_FIELDS = ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'];
const TAG = "[thirdparty/pdfsummary]";

const removeUpload = (file) => {
    if (!file) return;
    fs.rm(file.path, { recursive: true, force: true }, (err) => {
        if (err) console.error('Error deleting file:', err);
    });
};

// type "upload": PDF in field "image" (+ optional text) → new conversation with the PDF, first answer.
// type "run": threadId (the conversation) + text → next answer; without text → all answers so far.
// hashId (optional): the tool in AI Tools (its model, key and token cost).
exports.pdfSummaryBot = async (req, res) => {
    try {
        const uniqueId = req.headers['uniqueid'];
        const body = req.body
        const userData = await checkToken(body.deviceId)
        const getMetadata = userData.metadata != null ? JSON.parse(userData.metadata) : {}

        const tool = await resolveTool(body.hashId, userData);
        if (!tool) {
            removeUpload(req.file);
            return sendError(res, "ASSISTANT_NOT_FOUND");
        }
        const rToken = tool.reduceToken

        if (body.type === "upload") {
            if (!req.file) {
                return res.status(400).json({ message: "Please upload a .pdf file.", status: 400 })
            }
            const fileExtName = path.extname(req.file.originalname).toLowerCase()
            if (fileExtName !== ".pdf") {
                removeUpload(req.file);
                return res.status(400).json({ message: `Please upload only .pdf but got ${fileExtName}.`, status: 400 })
            }
            if (!(userData.reminToken > 0) || userData.reminToken < (rToken || 1)) {
                removeUpload(req.file);
                return res.status(400).json({ message: "Your Quota is Over" })
            }

            try {
                const form = new FormData();
                form.append('file', fs.createReadStream(req.file.path), {
                    filename: req.file.originalname || path.basename(req.file.path),
                    contentType: 'application/pdf',
                });
                form.append('purpose', 'user_data');
                const fileId = await uploadFile(tool.token, form)

                const threadUploadId = await createConversation(tool.token)
                const question = typeof body.text === "string" && body.text.trim() ? body.text : "Summarize this PDF."
                const text = await respond(tool, "pdf", [
                    { type: "input_file", file_id: fileId },
                    { type: "input_text", text: question },
                ], threadUploadId)

                // Charged only once OpenAI has answered
                await reduceToken(body.deviceId, uniqueId, "Bot", "pdfSummaryBot-Upload", true, rToken)

                getMetadata["pdfObj"] = { threadId: threadUploadId, fileId: fileId }
                await User.update(
                    { metadata: JSON.stringify(getMetadata) },
                    { where: { deviceId: body.deviceId } }
                );

                const updateUserData = await checkToken(body.deviceId)
                res.status(200).json({
                    data: { threadId: threadUploadId, fileId: fileId, content: [{ role: "assistant", text }], userDetails: pick(updateUserData, USER_FIELDS) },
                    status: 200
                });
            } catch (error) {
                sendProviderError(res, error, TAG);
            } finally {
                removeUpload(req.file);
            }
            return;
        }

        if (body.type === "run") {
            // Chats started before the Assistants API shutdown (thread_ ids) cannot be continued
            if (!/^conv_/.test(body.threadId || "")) {
                return res.status(400).json({ message: "This chat has expired. Please upload the PDF again.", status: 400 })
            }

            try {
                if (body.text) {
                    const text = await respond(tool, "pdf", [{ type: "input_text", text: body.text }], body.threadId)
                    const updateUserData = await checkToken(body.deviceId)
                    return res.status(200).json({
                        data: {
                            content: [{ role: "assistant", text }],
                            userDetails: pick(updateUserData, USER_FIELDS)
                        },
                        status: 200
                    })
                }

                const formatted = await assistantMessages(tool.token, body.threadId)
                return res.status(200).json({
                    data: {
                        content: formatted,
                        userDetails: pick(userData, USER_FIELDS)
                    },
                    status: 200
                })
            } catch (error) {
                return sendProviderError(res, error, TAG);
            }
        }

        removeUpload(req.file);
        res.status(400).json({ message: "Invalid Input", status: 400 })
    } catch (error) {
        console.log(error);
        removeUpload(req.file);
        if (res.headersSent) return;
        res.status(500).json({
            message: "Something went wrong",
            status: 500
        })
    }
}
