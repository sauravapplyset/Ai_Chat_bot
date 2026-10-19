const axios = require("axios");
const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash");
const { getModelToken, getActiveModel, getAssToken } = require("../../config/manageToken");
const AssistantModel = require("../../model/assistanceModel");
const commonFunction = require("../../common/commonFunction");
const { sendError, sendProviderError } = require("../../helper/statusCodes");

// Used when an assistant has no model chosen in the admin panel, or its model is inactive
const DEFAULT_ASSISTANT_MODEL = process.env.ASSISTANT_DEFAULT_MODEL || "gpt-5.6-luna";

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

        if (!userDetails) {
            return res.status(400).json({ message: "Unauthorized" });
        }
        // Same response as the other chat routes when the balance is used up
        if (!(userDetails.reminToken > 0)) {
            return sendError(res, "USER_QUOTA_OVER");
        }

        console.log(`${tag} ✅ User found | isSubscribe: ${apiSendUserDetails.isSubscribe} | plan: ${apiSendUserDetails.planType}`);

        // ── 2. Find assistant in DB ───────────────────────────────────────────
        const findAssi = await AssistantModel.findOne({
            where: { isActive: 1, hashId: id }
        });

        if (findAssi == null) {
            console.log(`${tag} ❌ Assistant not found in DB`);
            return sendError(res, "ASSISTANT_NOT_FOUND");
        }

        const modelTokens = await getAssToken(id);

        // Model chosen for this assistant in the admin panel (models table, provider openAi).
        // Its own key is used; otherwise the default model with the main OpenAI key.
        const assiModel = await getActiveModel("openAi", findAssi.dataValues.model);
        const openAiToken = assiModel || await getModelToken("openAi");
        const targetModel = assiModel ? assiModel.model : DEFAULT_ASSISTANT_MODEL;

        const promptId = findAssi.dataValues.assistantId; // Expected to be pmpt_...
        const token = apiSendUserDetails.isSubscribe == 1 ? openAiToken.proToken : openAiToken.token;
        const rToken = modelTokens.reduceToken;
        const assiName = modelTokens.name;

        console.log(`${tag} 💬 User [${body.deviceId}] interacting with Assistant [${assiName}] | Model Set: ${targetModel}`);

        // ── 3. Validate message body & Moderation ───────────────────────────────
        if (!body || !body.message) {
            console.log(`${tag} ❌ No message body provided`);
            return sendError(res, "MESSAGE_MISSING");
        }

        console.log(`${tag} 🔄 Running moderation check...`);
        for (const item of body.message) {
            const checkStatus = await commonFunction.checkModeration(item.text);
            if (checkStatus) {
                return sendError(res, "SEXUAL_CONTENT", { text: item.text });
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
            // A new chat costs rToken; it is charged only after OpenAI answers
            if (userDetails.reminToken < (rToken || 1)) {
                return sendError(res, "USER_QUOTA_OVER");
            }
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

            if (!body.threadId) {
                await reduceToken(body.deviceId, uniqueId, "openAi", `${assiName}`, true, rToken);
            }

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
            return sendProviderError(res, error, `${tag} ${targetModel}`);
        }

    } catch (error) {
        console.log(`${tag} ❌ Top-level unexpected error:`, error);
        return sendError(res, "SERVER_ERROR");
    }
};