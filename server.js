require("dotenv").config();

/* =========================
   GLOBAL ERROR HANDLERS
========================= */

process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION");
  console.error(err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ UNHANDLED REJECTION");
  console.error(err);
});

/* =========================
   IMPORTS
========================= */

console.log("✅ STEP 1 - Starting App");

const express = require("express");
console.log("✅ STEP 2 - Express Loaded");

const cors = require("cors");
console.log("✅ STEP 3 - Cors Loaded");

const cookieParser = require("cookie-parser");
console.log("✅ STEP 4 - Cookie Parser Loaded");

/* =========================
   APP INIT
========================= */

const app = express();

const PORT = process.env.PORT || 8080;

/* =========================
   MIDDLEWARES
========================= */

app.use(cors({
  origin: "*",
  credentials: true,
}));

app.use(cookieParser());

app.use(express.json({
  limit: "50mb",
}));

app.use(express.urlencoded({
  extended: true,
  limit: "50mb",
}));

console.log("✅ STEP 5 - Middlewares Loaded");

/* =========================
   HEALTH CHECK ROUTE
========================= */

app.get("/", (req, res) => {
  res.send("API RUNNING");
});

/* =========================
   LOAD ROUTES
========================= */

try {

  console.log("✅ STEP 6 - Loading Routes");

  // const { apiLogger } = require("./middleware/apiLogs");
  // app.use(apiLogger);

  const userRoutes = require("./routes/user.routes");
  console.log("✅ user.routes Loaded");

  const thirdPartyProvidor = require("./routes/thirdParty.routes");
  console.log("✅ thirdParty.routes Loaded");

  const subscription = require("./routes/subscription.routes");
  console.log("✅ subscription.routes Loaded");

  const manageToken = require("./routes/manageToken.routes");
  console.log("✅ manageToken.routes Loaded");

  const assistantRoutes = require("./routes/assistant.routes");
  console.log("✅ assistant.routes Loaded");

  const aiModelRoutes = require("./routes/aimodel.routes");
  console.log("✅ aimodel.routes Loaded");

  const mediaRoutes = require("./routes/media.routes");
  console.log("✅ media.routes Loaded");

  const conversationRoutes = require("./routes/conversation.routes");
  console.log("✅ conversation.routes Loaded");

  const adminRoutes = require("./routes/admin.routes");
  console.log("✅ admin.routes Loaded");

  /* =========================
     ROUTES REGISTER
  ========================= */

  app.use("/api/user", userRoutes);

  app.use("/api/thirdparty", thirdPartyProvidor);

  app.use("/api/plan", subscription);

  app.use("/api/manage", manageToken);

  app.use("/api/assi", assistantRoutes);

  app.use("/api/aiModel", aiModelRoutes);

  app.use("/api/media", mediaRoutes);

  app.use("/api/conversation", conversationRoutes);

  app.use("/api/admin", adminRoutes);

  console.log("✅ STEP 7 - All Routes Registered");

} catch (err) {

  console.error("❌ ROUTE LOADING ERROR");
  console.error(err);

}

/* =========================
   404 HANDLER
========================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route Not Found",
  });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */

app.use((err, req, res, next) => {

  console.error("❌ EXPRESS ERROR HANDLER");
  console.error(err);

  res.status(500).json({
    success: false,
    message: "Internal Server Error",
    error: err.message,
  });

});

/* =========================
   SERVER START
========================= */

const server = app.listen(PORT, "0.0.0.0", () => {

  console.log("=================================");
  console.log(`✅ SERVER RUNNING ON PORT ${PORT}`);
  console.log("=================================");

});

/* =========================
   SERVER ERROR
========================= */

server.on("error", (err) => {

  console.error("❌ SERVER FAILED TO START");
  console.error(err);

});

/* =========================
   GRACEFUL SHUTDOWN
========================= */

process.on("SIGTERM", () => {

  console.log("⚠️ SIGTERM RECEIVED");

  server.close(() => {

    console.log("✅ SERVER CLOSED");

    process.exit(0);

  });

});
