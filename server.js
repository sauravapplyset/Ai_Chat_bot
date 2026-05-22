const express = require("express");

const app = express();

const port = process.env.PORT || 8080;

app.get("/", (req, res) => {
  res.send("API Running Successfully");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});
