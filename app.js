import TelegramBot from 'node-telegram-bot-api';
import express from 'express';

const TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'ads_reward123_bot';

const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send(`Bot ${BOT_USERNAME} is running`);
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

bot.onText(/\/start/, (msg) => {

const chatId = msg.chat.id;

bot.sendMessage(chatId, "🎉 Welcome to Earn Points Bot", {
reply_markup: {
keyboard: [
["💰 Balance"],
["🎯 Earn Points", "👥 Referral"],
["💳 Withdraw"]
],
resize_keyboard: true
}
});

});

bot.on("message", (msg) => {
const chatId = msg.chat.id;
const text = msg.text;

if (text === "💰 Balance") {
bot.sendMessage(chatId, "💰 Your balance: 0 points");
}

if (text === "🎯 Earn Points") {
bot.sendMessage(chatId, "🎯 Watch ads to earn points.");
}

if (text === "👥 Referral") {
bot.sendMessage(chatId, `👥 Your referral link:\nhttps://t.me/${BOT_USERNAME}?start=${chatId}`);
}

if (text === "💳 Withdraw") {
bot.sendMessage(chatId, "💳 Minimum withdraw: 1000 points");
}
});
