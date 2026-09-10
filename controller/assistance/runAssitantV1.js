const axios = require("axios");
const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash");
const { getToken, getModelToken, getAssToken } = require("../../config/manageToken");
const AssistantModel = require("../../model/assistanceModel");
const commonFunction = require("../../common/commonFunction");

/**
 * runAssiV1 - Migrated to OpenAI Responses API using Cache Key (previous_response_id)
 */
exports.runAssiV1 = async (req, res) => {
    const tag = `[runAssiV1]`;
    try {
        let updateUserData;
        const uniqueId = req.headers.uniqueid;
        const appVersion = req.headers.appversion;
        const id = req.params.id;
        const body = req.body;

        console.log(`${tag} ▶ Request received | assistantHashId: ${id} | deviceId: ${body.deviceId} | cacheKey (threadId): ${body.threadId || 'NEW'}`);

        // ── 1. Validate user ─────────────────────────────────────────────────
        const userDetails = await checkToken(req.body.deviceId);
        const apiSendUserDetails = pick(userDetails, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate']);

        console.log(`${tag} ✅ User found | isSubscribe: ${apiSendUserDetails.isSubscribe} | plan: ${apiSendUserDetails.planType}`);

        // ── 2. Find assistant in DB ───────────────────────────────────────────
        const findAssi = await AssistantModel.findOne({
            where: { isActive: 1, hashId: id }
        });

        if (findAssi == null) {
            console.log(`${tag} ❌ Assistant not found in DB`);
            return res.status(400).json({ message: "Assistant Not Found" });
        }

        const openAiToken = await getModelToken("openAi");
        const modelTokens = await getAssToken(id);

        const promptId = findAssi.dataValues.assistantId; // Expected to be pmpt_...
        const token = apiSendUserDetails.isSubscribe == 1 ? openAiToken.proToken : openAiToken.token;
        const rToken = modelTokens.reduceToken;
        const assiName = modelTokens.name;
        
        const targetModel = "gpt-5.6-luna"; // Forced model override

        console.log(`${tag} 💬 User [${body.deviceId}] interacting with Assistant [${assiName}] | Model Set: ${targetModel}`);

        // ── 3. Validate message body & Moderation ───────────────────────────────
        if (!body || !body.message) {
            console.log(`${tag} ❌ No message body provided`);
            return res.status(400).json({ message: "Messages Missing" });
        }

        console.log(`${tag} 🔄 Running moderation check...`);
        for (const item of body.message) {
            const checkStatus = await commonFunction.checkModeration(item.text);
            if (checkStatus) {
                return res.status(400).json({
                    message: `A "${item.text}" might refer to content that is explicit...`
                });
            }
        }

        // ── 4. Build input for Responses API ─────────────────────────────────
        const inputContent = body.message.map(item => ({
            type: "input_text",
            text: item.text || ""
        }));

        const inputPayload = [
            {
                role: "user",
                content: inputContent
            }
        ];

        const requestPayload = {
            model: targetModel, // Overriding the default prompt model
            prompt: { id: promptId },
            input: inputPayload
        };

        // If client sends a threadId (which is actually the last resp_ ID), use it as Cache Key
        if (body.threadId) {
            console.log(`${tag} 🔗 Using previous_response_id (Cache Key): ${body.threadId}`);
            requestPayload.previous_response_id = body.threadId;
        } else {
            console.log(`${tag} ✨ No previous Cache Key, starting fresh response...`);
            // Deduct tokens when starting a completely new thread/chat
            await reduceToken(body.deviceId, uniqueId, "openAi", `${assiName}`, true, rToken);
        }

        // ── 5. Call Responses API ──────────────────────────────────────────────
        console.log(`${tag} 🔄 Calling Responses API | Model: ${targetModel} | User: ${body.deviceId} | Assistant: ${assiName}`);
        try {
            const responseRes = await axios.post(
                'https://api.openai.com/v1/responses',
                requestPayload,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    }
                }
            );

            // The new Response ID becomes our new Cache Key for the next message
            const newResponseId = responseRes.data.id;
            const returnedModel = responseRes.data.model || 'unknown'; // Log what model OpenAI actually used

            const outputText =
                responseRes.data.output_text ||
                responseRes.data.output?.find(item => item.type === 'message')?.content?.find(c => c.type === 'output_text')?.text ||
                "";

            console.log(`${tag} ✅ Response received | newResponseId: ${newResponseId} | Model Used by OpenAI: ${returnedModel}`);

            updateUserData = await checkToken(body.deviceId);

            const newSummriRes = {
                content: {
                    role: "assistant",
                    text: outputText,
                },
                threadId: newResponseId, // Send back the new resp_xxxx ID
                userDetails: pick(updateUserData, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'])
            };

            return res.status(200).json({ data: newSummriRes });

        } catch (error) {
            const statusCode = error?.response?.status;
            const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
            console.log(`${tag} ❌ FAILED to get response | Error: ${errMsg}`);
            console.log(`${tag} ❌ Raw OpenAI Response:`, JSON.stringify(error?.response?.data));
            return res.status(400).json({ message: errMsg });
        }

    } catch (error) {
        console.log(`${tag} ❌ Top-level unexpected error:`, error);
        return res.status(500).json({
            message: "Something went wrong",
            status: 500
        });
    }
};