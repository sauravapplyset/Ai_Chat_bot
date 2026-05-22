require("dotenv").config();

console.log("STEP 1");

const express = require("express");
console.log("STEP 2");

const cors = require("cors");
console.log("STEP 3");

const cookieParser = require("cookie-parser");
console.log("STEP 4");

const app = express();

const port = process.env.PORT || 8080;

app.use(cors({ origin: "*" }));
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

console.log("STEP 5");

try {

  const { apiLogger } = require("./middleware/apiLogs");
  app.use(apiLogger);

  console.log("STEP 6");

  const userRoutes = require("./routes/user.routes");
  console.log("STEP 7");

  const thirdPartyProvidor = require("./routes/thirdParty.routes");
  console.log("STEP 8");

  const subscription = require("./routes/subscription.routes");
  console.log("STEP 9");

  app.use("/api/user", userRoutes);
  app.use("/api/thirdparty", thirdPartyProvidor);
  app.use("/api/plan", subscription);

  app.use("/api/manage", require("./routes/manageToken.routes"));
  app.use("/api/assi", require("./routes/assistant.routes"));
  app.use("/api/aiModel", require("./routes/aimodel.routes"));
  app.use("/api/media", require("./routes/media.routes"));
  app.use("/api/conversation", require("./routes/conversation.routes"));
  app.use("/api/admin", require("./routes/admin.routes"));

  console.log("STEP 10");

} catch (err) {

  console.error("APP CRASHED:");
  console.error(err);

}

app.get("/", (req, res) => {
  res.send("API RUNNING");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});
