// middleware/loggerMiddleware.js

const logger = require('../logger/winston');
const ApiLog = require('../model/apilog.model');

exports.apiLogger = (req, res, next) => {

  console.log("➡️ API HIT:", req.method, req.originalUrl);

  const startHrTime = process.hrtime();
  const startCpu = process.cpuUsage();

  res.on('finish', async () => {

    console.log("✅ RESPONSE FINISHED");

    const elapsedHrTime = process.hrtime(startHrTime);
    const elapsedMs =
      elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6;

    const cpuUsed = process.cpuUsage(startCpu);

    const cpuUserMs = cpuUsed.user / 1000;
    const cpuSystemMs = cpuUsed.system / 1000;

    const logMsg = `${req.method} ${req.originalUrl} ${res.statusCode} - ${elapsedMs.toFixed(2)} ms (CPU: user ${cpuUserMs.toFixed(2)} ms, sys ${cpuSystemMs.toFixed(2)} ms)`;

    logger.info(logMsg);

    console.log("📌 Request Body:", req.body);

    try {

      console.log("🟡 TRY BLOCK START");

      const savedData = await ApiLog.create({
        deviceId: req.body?.deviceId || null,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        body: req.body || {},
        responseTimeMs: elapsedMs,
        cpuUserTimeMs: cpuUserMs,
        cpuSystemTimeMs: cpuSystemMs,
      });

      console.log("✅ DATA SAVED SUCCESSFULLY");

      console.log("📌 Saved ID:", savedData._id);

    } catch (err) {

      console.log("❌ ERROR INSIDE TRY-CATCH");

      console.log("❌ Error Message:", err.message);

      console.log("❌ Full Error:", err);

      console.log("❌ Error Stack:", err.stack);

      logger.error(`DB Log Error: ${err.message}`);

    }

  });

  next();
};
