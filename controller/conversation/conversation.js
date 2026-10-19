const axios = require("axios");
const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash")
const Model = require("../../model/aiModel.model");
let threadId = "thread_123"
const commonFunction = require("../../common/commonFunction");
const { sendError, sendProviderError } = require("../../helper/statusCodes");

const USER_FIELDS = ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'];
const TAG = "[converzation]";

// Reply text of a Responses API call. Reasoning models (o3, gpt-5.x) put a
// "reasoning" item before the message, so never assume output[0] is the message.
const openAiReply = (data) => {
    const msg = (data.output || []).find((v) => v.type == "message");
    const part = msg?.content?.find((c) => c.type == "output_text") || msg?.content?.[0];
    if (!msg || !part) return null;
    return {
        role: msg.role,
        type: part.type,
        text: part.type == "refusal" ? part.refusal : part.text,
        refused: part.type == "refusal",
    };
};

exports.converzationProvider = async (req, res) => {
    try {
        const uniqueId = req.headers.uniqueid
        const body = req.body
        const { deviceId, apiProvider, modelId } = body
        let conversationsId = body.conversationsId
        let updateUserData

        if (!Array.isArray(body.message) || body.message.length == 0) {
            return sendError(res, "MESSAGE_MISSING");
        }

        const notusedToken = await checkToken(body.deviceId)
        let apiSendUserDetails = pick(notusedToken, USER_FIELDS);
        const reminToken = notusedToken.reminToken
        if (reminToken == 0) {
            return sendError(res, "USER_QUOTA_OVER");
        }

        // Inactive models are hidden from /aiModel/getAll and cannot be used either
        const findModel = await Model.findOne({ where: { modelType: apiProvider, id: Number(modelId), isActive: 1 } })
        if (findModel == null) {
            return sendError(res, "MODEL_NOT_FOUND");
        }
        const token = apiSendUserDetails.isSubscribe == 1 ? findModel.dataValues.proToken : findModel.dataValues.token
        const model = findModel.dataValues.model
        const rToken = findModel.dataValues.reduceToken

        // A new chat costs rToken; refuse before calling the provider when the balance is too low
        const isNewChat = apiProvider === "openAi" ? (!conversationsId || body.threadId == null || body.threadId == "") : (body.threadId == null || body.threadId == "");
        if (isNewChat && reminToken < (rToken || 1)) {
            return sendError(res, "USER_QUOTA_OVER");
        }

        // Sexual / explicit text is refused before it reaches the provider
        const texts = body.message.map((m) => m && m.type != "image" && m.text).filter((t) => typeof t == "string" && t.trim());
        const flagged = await Promise.all(texts.map((t) => commonFunction.checkSexualContent(t)));
        if (flagged.some(Boolean)) {
            return sendError(res, "SEXUAL_CONTENT", { text: texts[flagged.findIndex(Boolean)] });
        }

        let resOpenObj = {
            content: {},
            userDetails: apiSendUserDetails
        }
        const inputObj = await this.apiInputObj(apiProvider, body)

        if (apiProvider === "openAi") {
            const headers = {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            };
            try {
                let deduct = false;
                let inputBody;
                if (!conversationsId) {
                    const createConver = await axios({
                        url: 'https://api.openai.com/v1/conversations',
                        method: 'post',
                        headers,
                        data: { "metadata": { "topic": "demo" } }
                    });
                    conversationsId = createConver.data.id
                    inputBody = { "model": model, "conversation": conversationsId, "input": [inputObj] }
                    deduct = true;
                } else {
                    inputBody = { "model": `${model}`, "conversation": { id: conversationsId }, "input": [inputObj] }
                    deduct = body.threadId == null || body.threadId == "";
                }

                const createConversations = await axios({
                    url: 'https://api.openai.com/v1/responses',
                    method: 'post',
                    headers,
                    data: inputBody
                });

                const reply = openAiReply(createConversations.data);
                if (!reply) {
                    console.log(`${TAG} ❌ No message in OpenAI output | model: ${model} | status: ${createConversations.data.status}`);
                    return sendError(res, "SERVER_ERROR");
                }
                if (reply.refused) {
                    console.log(`${TAG} ❌ OpenAI refused | model: ${model}`);
                    return sendError(res, "CONTENT_POLICY");
                }

                // Charge only after the provider answered
                if (deduct) {
                    await reduceToken(deviceId, uniqueId, apiProvider, conversationsId == body.conversationsId ? "converzationOpenAi" : "converzation", true, rToken);
                    updateUserData = await checkToken(deviceId)
                    resOpenObj["userDetails"] = pick(updateUserData, USER_FIELDS)
                }

                resOpenObj["content"]["id"] = conversationsId
                resOpenObj["content"]["role"] = reply.role
                resOpenObj["content"]["text"] = reply.text
                resOpenObj["content"]["type"] = reply.type
                resOpenObj["content"]["threadId"] = threadId

                return res.status(200).json({
                    data: resOpenObj
                })
            } catch (error) {
                return sendProviderError(res, error, `${TAG} openAi ${model}`);
            }
        }

        if (apiProvider === "Gemini") {
            try {
                let chatCompletions = await axios({
                    url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${token}`,
                    method: 'post',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    data: inputObj
                });
                const candidate = chatCompletions.data.candidates?.[0];
                const parts = candidate?.content?.parts;
                if (!parts || chatCompletions.data.promptFeedback?.blockReason) {
                    console.log(`${TAG} ❌ Gemini returned no text | finishReason: ${candidate?.finishReason} | blockReason: ${chatCompletions.data.promptFeedback?.blockReason}`);
                    const blocked = chatCompletions.data.promptFeedback?.blockReason || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(candidate?.finishReason);
                    return sendError(res, blocked ? "CONTENT_POLICY" : "SERVER_ERROR");
                }

                if (body.threadId == null || body.threadId == "") {
                    await reduceToken(deviceId, uniqueId, apiProvider, "converzationGemini", true, rToken);
                }

                const newRes = {
                    role: candidate.content.role,
                    text: parts.map((v) => v.text).join(","),
                    threadId: threadId
                }
                updateUserData = await checkToken(deviceId)

                return res.status(200).json({
                    data: {
                        content: newRes,
                        userDetails: pick(updateUserData, USER_FIELDS)
                    }
                })
            } catch (error) {
                return sendProviderError(res, error, `${TAG} Gemini`);
            }
        }

        if (apiProvider === "MistralAi") {
            try {
                let chatCompletions = await axios({
                    url: 'https://api.mistral.ai/v1/chat/completions',
                    method: 'post',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    data: {
                        "model": "pixtral-12b-latest",
                        "messages": [inputObj],
                        "temperature": 0.7,
                        "max_tokens": 256
                    }
                });

                if (body.threadId == null || body.threadId == "") {
                    await reduceToken(deviceId, uniqueId, apiProvider, "converzationMistralAi", true, rToken);
                }

                const contentRes = { role: chatCompletions.data.choices[0]["message"]["role"], text: chatCompletions.data.choices[0]["message"]["content"], threadId: threadId }
                updateUserData = await checkToken(deviceId)

                return res.status(200).json({
                    data: {
                        content: contentRes,
                        userDetails: pick(updateUserData, USER_FIELDS),
                    }
                })
            } catch (error) {
                return sendProviderError(res, error, `${TAG} MistralAi`);
            }
        }

        // A model row whose provider this server cannot call
        return sendError(res, "MODEL_NOT_FOUND");
    } catch (error) {
        console.log(`${TAG} ❌ Unexpected error:`, error);
        return sendError(res, "SERVER_ERROR");
    }
};


exports.apiInputObj = async (type, body) => {
    try {
        let finalMessageObj = {}

        if (type == "openAi") {
            const role = body.message[0]["role"]
            finalMessageObj["role"] = role

            const openMessArr = []
            for (let i = 0; i < body.message.length; i++) {
                let openMessObj = {}

                const type = body.message[i]["type"];
                const text = body.message[i]["text"];
                const imageData = body.message[i]["imageData"];

                if (type == "image") {
                    openMessObj["type"] = "input_image"
                    openMessObj["image_url"] = imageData
                } else {
                    openMessObj["text"] = text
                    openMessObj["type"] = "input_text"
                }

                openMessArr.push(openMessObj)
                openMessObj = {}
            }
            finalMessageObj["content"] = openMessArr
            return finalMessageObj;

        } else if (type == "Gemini") {
            const geminiMessArr = []
            for (let i = 0; i < body.message.length; i++) {
                let geminiMessObj = {}

                const type = body.message[i]["type"];
                const text = body.message[i]["text"];
                const imageData = body.message[i]["imageData"];
                const mimeType = body.message[i]["mimeType"];

                if (type == "image") {
                    geminiMessObj["inlineData"] = {
                        mimeType: mimeType,
                        data: imageData
                    }
                } else {
                    geminiMessObj["text"] = text
                }
                geminiMessArr.push(geminiMessObj)
                geminiMessObj = {}
            }
            finalMessageObj["contents"] = [{ parts: geminiMessArr }]
            return finalMessageObj;

        } else if (type == "MistralAi") {
            const role = body.message[0]["role"]
            finalMessageObj["role"] = role

            const misMessArr = []
            for (let i = 0; i < body.message.length; i++) {
                let misMessObj = {}

                const type = body.message[i]["type"];
                const text = body.message[i]["text"];
                const imageData = body.message[i]["imageData"];

                if (type == "image") {
                    misMessObj["type"] = "image_url"
                    misMessObj["image_url"] = { url: imageData }
                } else {
                    misMessObj["type"] = "text"
                    misMessObj["text"] = text
                }
                misMessArr.push(misMessObj)
                misMessObj = {}
            }
            finalMessageObj["content"] = misMessArr
            return finalMessageObj;
        }

    } catch (error) {
        console.log("---inout creation error ---", error)
    }
};
