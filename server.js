console.log("NEW BUILD TEST");

require("dotenv").config();

const express = require("express");

const app = express();

const port = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.send("Cloud Run Working Successfully");
});

app.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "API Running"
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});
