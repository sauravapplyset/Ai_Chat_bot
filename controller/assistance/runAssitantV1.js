const axios = require("axios");
const { checkToken, reduceToken } = require("../../helper/common");
const { pick } = require("lodash");
const { getToken, getModelToken, getAssToken } = require("../../config/manageToken");
const AssistantModel = require("../../model/assistanceModel");
const commonFunction = require("../../common/commonFunction");

exports.runAssiV1 = async (req, res) => {
    const tag = `[runAssiV1]`;
    try {
        let updateUserData
        const uniqueId = req.headers.uniqueid
        const appVersion = req.headers.appversion
        const id = req.params.id
        const body = req.body;

        console.log(`${tag} ▶ Request received | assistantHashId: ${id} | deviceId: ${body.deviceId} | threadId: ${body.threadId || 'NEW'}`);

        const userDetails = await checkToken(req.body.deviceId)
        const apiSendUserDetails = pick(userDetails, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate']);

        console.log(`${tag} ✅ User found | isSubscribe: ${apiSendUserDetails.isSubscribe} | reminToken: ${apiSendUserDetails.reminToken} | plan: ${apiSendUserDetails.planType}`);

        const findAssi = await AssistantModel.findOne({
            where: {
                isActive: 1,
                hashId: id
            }
        })

        if (findAssi == null) {
            console.log(`${tag} ❌ Assistant not found in DB for hashId: ${id}`);
            return res.status(400).json({
                message: "Assistant Not Found"
            })
        }

        const openAiToken = await getModelToken("openAi");
        const modelTokens = await getAssToken(id);
        const assistantId = findAssi.dataValues.assistantId
        const token = apiSendUserDetails.isSubscribe == 1 ? openAiToken.proToken : openAiToken.token
        const rToken = modelTokens.reduceToken
        const assiName = modelTokens.name

        // Log which token type is being used (mask the key for security)
        const maskedToken = token ? `${token.substring(0, 10)}...${token.slice(-4)}` : 'NULL';
        console.log(`${tag} ✅ Assistant found | assistantId: ${assistantId} | name: ${assiName} | using: ${apiSendUserDetails.isSubscribe == 1 ? 'proToken' : 'normalToken'} | key: ${maskedToken}`);

        if (!body.threadId || body.threadId == null) {
            console.log(`${tag} 🔄 No threadId provided, creating new thread...`);
            try {
                let createThread = await axios({
                    url: 'https://api.openai.com/v1/threads',
                    method: 'post',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'OpenAI-Beta': 'assistants=v2',
                        'Content-Type': 'application/json'
                    },
                    data: {}
                });
                const pickThredData = pick(createThread.data, 'id')
                console.log(`${tag} ✅ Thread created successfully | threadId: ${pickThredData.id}`);
                await reduceToken(body.deviceId, uniqueId, "openAi", `${assiName}`, true, rToken)
                body["threadId"] = pickThredData.id
            } catch (error) {
                const statusCode = error?.response?.status;
                const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
                console.log(`${tag} ❌ FAILED to create thread | HTTP Status: ${statusCode} | OpenAI Error: ${errMsg}`);
                console.log(`${tag} ❌ OpenAI Raw Response:`, JSON.stringify(error?.response?.data));
                return res.status(400).json({
                    message: errMsg
                })
            }
        } else {
            console.log(`${tag} ✅ Using existing threadId: ${body.threadId}`);
        }

        if (body && body.message) {
            console.log(`${tag} 🔄 Running moderation check on ${body.message.length} message(s)...`);
            for (const item of body.message) {
                const checkStatus = await commonFunction.checkModeration(item.text);
                if (checkStatus) {
                    console.log(`${tag} ❌ Message blocked by moderation: "${item.text?.substring(0, 50)}..."`);
                    return res.status(400).json({
                        message: `A "${item.text}" might refer to content that is explicit, sexual, or involves descriptions of nudity. However, sharing or promoting such text is often inappropriate and may violate community guidelines, moral standards, and even laws in some cases.\n\nIf you're using the term in a different context, could you please provide more details to help me better understand what you mean?`
                    });
                }
            }

            console.log(`${tag} ✅ Moderation passed`);

            const updated = body.message.map(obj => {
                const newObj = { ...obj };
                if ("role" in newObj) delete newObj.role;
                return newObj;
            });
            const newContents = updated.map(({ ...rest }) => ({
                ...rest,
                type: "text"
            }));

            try {
                // STEP 1: Add message to thread
                console.log(`${tag} 🔄 Adding user message to thread: ${body.threadId}`);
                try {
                    let runSummari = await axios({
                        url: `https://api.openai.com/v1/threads/${body.threadId}/messages`,
                        method: 'post',
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'OpenAI-Beta': 'assistants=v2',
                            'Content-Type': 'application/json'
                        },
                        data: {
                            role: "user",
                            content: newContents
                        }
                    });
                    console.log(`${tag} ✅ Message added to thread | messageId: ${runSummari?.data?.id}`);
                } catch (error) {
                    const statusCode = error?.response?.status;
                    const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
                    console.log(`${tag} ❌ FAILED to add message to thread | HTTP Status: ${statusCode} | OpenAI Error: ${errMsg}`);
                    console.log(`${tag} ❌ OpenAI Raw Response:`, JSON.stringify(error?.response?.data));
                    return res.status(400).json({
                        message: errMsg,
                        status: 400
                    });
                }

                // STEP 2: Create a run
                console.log(`${tag} 🔄 Creating run for thread: ${body.threadId} with assistantId: ${assistantId}`);
                let runRes = ""
                try {
                    runRes = await axios.post(
                        `https://api.openai.com/v1/threads/${body.threadId}/runs`,
                        {
                            assistant_id: assistantId,
                        },
                        {
                            headers: {
                                Authorization: `Bearer ${token}`,
                                'OpenAI-Beta': 'assistants=v2',
                                'Content-Type': 'application/json',
                            },
                        }
                    );
                    console.log(`${tag} ✅ Run created | runId: ${runRes?.data?.id} | status: ${runRes?.data?.status}`);
                } catch (error) {
                    const statusCode = error?.response?.status;
                    const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
                    console.log(`${tag} ❌ FAILED to create run | HTTP Status: ${statusCode} | OpenAI Error: ${errMsg}`);
                    console.log(`${tag} ❌ OpenAI Raw Response:`, JSON.stringify(error?.response?.data));
                    return res.status(400).json({
                        message: errMsg,
                        status: 400
                    });
                }

                const runId = runRes.data.id;

                // STEP 3: Poll run status
                let runStatus = 'queued';
                let pollCount = 0;
                console.log(`${tag} 🔄 Polling run status | runId: ${runId}`);
                while (runStatus !== 'completed') {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                    pollCount++;

                    try {
                        const pollRes = await axios.get(
                            `https://api.openai.com/v1/threads/${body.threadId}/runs/${runId}`,
                            {
                                headers: {
                                    Authorization: `Bearer ${token}`,
                                    'OpenAI-Beta': 'assistants=v2',
                                    'Content-Type': 'application/json'
                                },
                            }
                        );

                        runStatus = pollRes.data.status;
                        console.log(`${tag} 🔄 Poll #${pollCount} | runStatus: ${runStatus}`);

                        if (runStatus === 'failed' || runStatus === 'cancelled') {
                            const failReason = pollRes?.data?.last_error?.message || `Run ${runStatus}`;
                            console.log(`${tag} ❌ Run ended with status: ${runStatus} | Reason: ${failReason}`);
                            res.status(400).json({
                                message: failReason,
                                status: 400
                            })
                            return;
                        }
                    } catch (error) {
                        const statusCode = error?.response?.status;
                        const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
                        console.log(`${tag} ❌ FAILED to poll run status | HTTP Status: ${statusCode} | OpenAI Error: ${errMsg}`);
                        return res.status(400).json({
                            message: errMsg,
                            status: 400
                        });
                    }
                }

                // STEP 4: Get messages
                console.log(`${tag} 🔄 Run completed! Fetching assistant response...`);
                let answerRes = await axios.get(
                    `https://api.openai.com/v1/threads/${body.threadId}/messages`,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'OpenAI-Beta': 'assistants=v2',
                            'Content-Type': 'application/json'
                        },
                    }
                );

                answerRes = answerRes.data.data
                const lastMsg = answerRes.find((m) => m.role === "assistant");
                updateUserData = await checkToken(body.deviceId)

                const newSummriRes = {
                    content: {
                        role: lastMsg.role,
                        text: lastMsg["content"][0]["text"]["value"] || "",
                    },
                    threadId: body.threadId,
                    userDetails: pick(updateUserData, ['id', 'totalToken', 'usedToken', 'reminToken', 'planType', 'isSubscribe', 'expireDate'])
                };

                console.log(`${tag} ✅ SUCCESS | Response sent to client | threadId: ${body.threadId}`);
                res.status(200).json({
                    data: newSummriRes
                })
            } catch (error) {
                const errMsg = error?.response?.data?.error?.message || error?.message || "An error occurred";
                console.log(`${tag} ❌ Unexpected error in main flow | ${errMsg}`);
                console.log(error);
                return res.status(400).json({
                    message: errMsg
                })
            }

        } else {
            console.log(`${tag} ❌ No message body provided in request`);
            res.status(400).json({
                message: "Messages Missing"
            })
        }
    } catch (error) {
        console.log(`${tag} ❌ Top-level unexpected error:`, error);
        res.status(500).json({
            message: "Something went wrong",
            status: 500
        })
    }
};