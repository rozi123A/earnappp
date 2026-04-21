
const express = require("express");
const app = express();

const BOT_USERNAME = process.env.BOT_USERNAME ?? "ads_reward123_bot";

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Bot " + BOT_USERNAME + " is running");
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
