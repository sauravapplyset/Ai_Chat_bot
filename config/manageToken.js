const TokenModel = require("../model/manageToken.model");
const Model = require("../model/aiModel.model");
const Ass = require("../model/assistanceModel");

async function getToken(key) {
    let config = await TokenModel.findAll();
    const findKey = config.find((v) => v.type == key).dataValues
    return findKey;
}

// Prefers an active row, so a new model added as inactive (still being tested) never
// supplies the key for live traffic
async function getModelToken(type, model) {
    const where = model ? { modelType: type, model: model } : { modelType: type };
    const config = await Model.findOne({ where, order: [['isActive', 'DESC'], ['id', 'ASC']] });
    return { token: config.dataValues.token, proToken: config.dataValues.proToken };
}

// Model row for an assistant: its own model when that model is active, else null
async function getActiveModel(type, model) {
    if (!model) return null;
    const config = await Model.findOne({ where: { modelType: type, model: model, isActive: 1 } });
    return config ? config.dataValues : null;
}

async function getAssToken(hashId) {
    let config = await Ass.findOne({ where: { hashId: hashId } })
    return { reduceToken: config.dataValues.reduceToken, name: config.dataValues.nameAssistant };
}


module.exports = { getToken, getModelToken, getActiveModel, getAssToken };