const { sendError, sendProviderError } = require("../../helper/statusCodes");
const { checkToken, reduceToken } = require("../../helper/common");
const User = require("../../model/user.model");
const { pick } = require("lodash");
const { resolveTool, createConversation } = require("../../helper/aiTools");


// Starts a chat for the AI tools. The Assistants API (threads) is shut down, so this creates an
// OpenAI conversation; its id (conv_...) is returned as before and the app sends it back as threadId.
// hashId (optional): the tool, so the conversation is created with that tool's OpenAI key.
exports.createThread = async (req, res) => {
    try {
        const { deviceId, hashId } = req.body;
        const uniqueId = req.headers.uniqueid
        const notusedToken = await checkToken(deviceId)
        const tool = await resolveTool(hashId, notusedToken);
        if (!tool) {
            return sendError(res, "ASSISTANT_NOT_FOUND");
        }
        try {
            const createThread = { id: await createConversation(tool.token) }

            let getMetadata = notusedToken.metadata != null ? JSON.parse(notusedToken.metadata) : {}
            getMetadata["openAi"] = createThread.id
            await reduceToken(deviceId, uniqueId, "OpenAi", "createThread", true)
            const updateUserData = await checkToken(deviceId)
            createThread["userDetails"] = pick(updateUserData, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate']);

            await User.update(
                { metadata: JSON.stringify(getMetadata) },
                { where: { deviceId: deviceId } }
            );

            res.status(200).json({
                data: createThread
            })
        } catch (error) {
            sendProviderError(res, error, "[thirdparty/threadCreate]");
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({
            message: "Something went wrong",
            status: 500
        })
    }
}
