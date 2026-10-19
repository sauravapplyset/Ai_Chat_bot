// middleware/loggerMiddleware.js
const logger = require('../logger/winston');
const ApiLog = require('../model/apilog.model');
const statusCodes = require('../helper/statusCodes');

// Keep log rows small: long strings (base64 images, long chats) are cut, so a
// 50 MB request cannot fill the database.
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const shrink = (value, depth = 0) => {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => shrink(v, depth + 1));
    if (value.length > 20) items.push(`… [${value.length} items]`);
    return items;
  }
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 50)) out[k] = shrink(v, depth + 1);
  return out;
};

exports.apiLogger = (req, res, next) => {
  const startHrTime = process.hrtime();
  const startCpu = process.cpuUsage();

  res.on('finish', async () => {
    const elapsedHrTime = process.hrtime(startHrTime);
    const elapsedMs = elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6;

    const cpuUsed = process.cpuUsage(startCpu);
    const cpuUserMs = cpuUsed.user / 1000;
    const cpuSystemMs = cpuUsed.system / 1000;

    const logMsg = `${req.method} ${req.originalUrl} ${res.statusCode} - ${elapsedMs.toFixed(2)} ms (CPU: user ${cpuUserMs.toFixed(2)} ms, sys ${cpuSystemMs.toFixed(2)} ms)`;

    logger.info(logMsg);

    // GET requests have no body in Express 5, and deviceId is required by the table
    const deviceId = req.body?.deviceId;
    if (!deviceId) return;

    try {
      await ApiLog.create({
        deviceId: String(deviceId).slice(0, 255),
        method: req.method,
        url: String(req.originalUrl).slice(0, 255),
        statusCode: res.statusCode,
        body: shrink(req.body),
        responseTimeMs: elapsedMs,
        cpuUserTimeMs: cpuUserMs,
        cpuSystemTimeMs: cpuSystemMs,
        // Only once the column exists (created at startup by helper/statusCodes.js)
        ...(res.locals.errorKey && statusCodes.isLoaded() ? { errorKey: res.locals.errorKey } : {}),
      });
    } catch (err) {
      logger.error(`DB Log Error: ${err.message}`);
    }
  });

  next();
};