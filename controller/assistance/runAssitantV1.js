const axios = require("axios");
const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash");
const { getToken, getModelToken, getAssToken } = require("../../config/manageToken");
const AssistantModel = require("../../model/assistanceModel");
const commonFunction = require("../../common/commonFunction");

/**
 * runAssiV1 - Migrated from OpenAI Assistants API (sunset Aug 26, 2026)
 *             to OpenAI Responses API (Conversations + Responses)
 *
 * IMPORTANT: The `assistantId` field in the DB must now store the OpenAI Prompt ID
 *            (format: pmpt_...) instead of the old Assistant ID (asst_...).
 *            To get prompt IDs:
 *            1. Go to platform.openai.com dashboard
 *            2. Find each Assistant → Click "Create Prompt"
 *            3. Copy the new pmpt_... ID and update the DB
 *
 * Route paths are unchanged so live app is not affected.
 * Client-side `threadId` now maps to OpenAI `conversationId` internally.
 */
exports.runAssiV1 = async (req, res) => {
    const tag = `[runAssiV1]`;
    try {
        let updateUserData;
        const uniqueId = req.headers.uniqueid;
        const appVersion = req.headers.appversion;
        const id = req.params.id;
        const body = req.body;

        console.log(`${tag} ▶ Request received | assistantHashId: ${id} | deviceId: ${body.deviceId} | threadId: ${body.threadId || 'NEW'}`);

        // ── 1. Validate user ─────────────────────────────────────────────────
        const userDetails = await checkToken(req.body.deviceId);
        const apiSendUserDetails = pick(userDetails, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate']);

        console.log(`${tag} ✅ User found | isSubscribe: ${apiSendUserDetails.isSubscribe} | reminToken: ${apiSendUserDetails.reminToken} | plan: ${apiSendUserDetails.planType}`);

        // ── 2. Find assistant in DB ───────────────────────────────────────────
        const findAssi = await AssistantModel.findOne({
            where: { isActive: 1, hashId: id }
        });

        if (findAssi == null) {
            console.log(`${tag} ❌ Assistant not found in DB for hashId: ${id}`);
            return res.status(400).json({ message: "Assistant Not Found" });
        }

        const openAiToken = await getModelToken("openAi");
        const modelTokens = await getAssToken(id);

        // NOTE: assistantId now stores the OpenAI Prompt ID (pmpt_...)
        const promptId = findAssi.dataValues.assistantId;
        const token = apiSendUserDetails.isSubscribe == 1 ? openAiToken.proToken : openAiToken.token;
        const rToken = modelTokens.reduceToken;
        const assiName = modelTokens.name;

        const maskedToken = token ? `${token.substring(0, 10)}...${token.slice(-4)}` : 'NULL';
        console.log(`${tag} ✅ Assistant found | promptId: ${promptId} | name: ${assiName} | using: ${apiSendUserDetails.isSubscribe == 1 ? 'proToken' : 'normalToken'} | key: ${maskedToken}`);

        // ── 3. Create conversation if no threadId ─────────────────────────────
        // (threadId from client = conversationId internally - backward compatible)
        let conversationId = body.threadId;

        if (!conversationId || conversationId == null) {
            console.log(`${tag} 🔄 No conversationId provided, creating new conversation via Responses API...`);
            try {
                const createConv = await axios({
                    url: 'https://api.openai.com/v1/conversations',
                    method: 'post',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    data: {}
                });

                conversationId = createConv.data.id;
                console.log(`${tag} ✅ Conversation created | conversationId: ${conversationId}`);

                await reduceToken(body.deviceId, uniqueId, "openAi", `${assiName}`, true, rToken);

            } catch (error) {
                const statusCode = error?.response?.status;
                const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
                console.log(`${tag} ❌ FAILED to create conversation | HTTP Status: ${statusCode} | Error: ${errMsg}`);
                console.log(`${tag} ❌ Raw Response:`, JSON.stringify(error?.response?.data));
                return res.status(400).json({ message: errMsg });
            }
        } else {
            console.log(`${tag} ✅ Using existing conversationId: ${conversationId}`);
        }

        // ── 4. Validate message body ──────────────────────────────────────────
        if (!body || !body.message) {
            console.log(`${tag} ❌ No message body provided`);
            return res.status(400).json({ message: "Messages Missing" });
        }

        // ── 5. Moderation check ───────────────────────────────────────────────
        console.log(`${tag} 🔄 Running moderation check on ${body.message.length} message(s)...`);
        for (const item of body.message) {
            const checkStatus = await commonFunction.checkModeration(item.text);
            if (checkStatus) {
                console.log(`${tag} ❌ Message blocked by moderation`);
                return res.status(400).json({
                    message: `A "${item.text}" might refer to content that is explicit, sexual, or involves descriptions of nudity. However, sharing or promoting such text is often inappropriate and may violate community guidelines, moral standards, and even laws in some cases.\n\nIf you're using the term in a different context, could you please provide more details to help me better understand what you mean?`
                });
            }
        }
        console.log(`${tag} ✅ Moderation passed`);

        // ── 6. Build input for Responses API ─────────────────────────────────
        // Map body.message to Responses API input format
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

        // ── 7. Call Responses API (replaces: add message + create run + poll) ─
        console.log(`${tag} 🔄 Calling Responses API | conversationId: ${conversationId} | promptId: ${promptId}`);
        try {
            const responseRes = await axios.post(
                'https://api.openai.com/v1/responses',
                {
                    prompt: { id: promptId },
                    input: inputPayload,
                    conversation: conversationId,
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    }
                }
            );

            // Extract assistant text from response
            const outputText =
                responseRes.data.output_text ||
                responseRes.data.output?.find(item => item.type === 'message')?.content?.find(c => c.type === 'output_text')?.text ||
                "";

            console.log(`${tag} ✅ Response received | conversationId: ${conversationId} | outputLength: ${outputText.length}`);

            updateUserData = await checkToken(body.deviceId);

            // Return in same format as before — threadId is now the conversationId
            // Client side remains unchanged (backward compatible)
            const newSummriRes = {
                content: {
                    role: "assistant",
                    text: outputText,
                },
                threadId: conversationId,   // conv_... (was thread_... before)
                userDetails: pick(updateUserData, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'])
            };

            console.log(`${tag} ✅ SUCCESS | Response sent to client`);
            return res.status(200).json({ data: newSummriRes });

        } catch (error) {
            const statusCode = error?.response?.status;
            const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
            console.log(`${tag} ❌ FAILED to get response | HTTP Status: ${statusCode} | Error: ${errMsg}`);
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