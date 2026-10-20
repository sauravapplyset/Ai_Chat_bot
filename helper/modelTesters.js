// helper/modelTesters.js
// Devices that may use inactive AI models, so a new model can be tried before it
// is switched on for everyone. Everyone else still gets inactive models refused
// (chat) or replaced by the default model (assistants).
//
// MODEL_TEST_DEVICES="deviceId1,deviceId2" (device IDs from the admin panel Users page)

const TEST_DEVICES = new Set(
    (process.env.MODEL_TEST_DEVICES || "").split(",").map((id) => id.trim()).filter(Boolean)
);

const isModelTester = (deviceId) => !!deviceId && TEST_DEVICES.has(String(deviceId));

module.exports = { isModelTester };
