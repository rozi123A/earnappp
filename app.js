const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'ads_reward123_bot';

const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
const PORT = process.env.PORT || 10000;

// تخزين المستخدمين والنقاط
let users = {};

app.get("/", (req, res) => {
  res.send(`Bot ${BOT_USERNAME} is running`);
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

// أمر start
bot.onText(/\/start/, (msg) => {

  const chatId = msg.chat.id;

  if (!users[chatId]) {
    users[chatId] = { balance: 0 };
  }

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

// الأزرار
bot.on("message", (msg) => {

  const chatId = msg.chat.id;
  const text = msg.text;

  if (!users[chatId]) {
    users[chatId] = { balance: 0 };
  }

  if (text === "💰 Balance") {
    bot.sendMessage(chatId, `💰 Your balance: ${users[chatId].balance} points`);
  }

  if (text === "🎯 Earn Points") {

    users[chatId].balance += 10;

    bot.sendMessage(chatId,
      `🎯 You earned 10 points!\n\n💰 New balance: ${users[chatId].balance}`
    );
  }

  if (text === "👥 Referral") {
    bot.sendMessage(
      chatId,
      `👥 Your referral link:\nhttps://t.me/${BOT_USERNAME}?start=${chatId}`
    );
  }

  if (text === "💳 Withdraw") {

    if (users[chatId].balance < 1000) {
      bot.sendMessage(chatId, "❌ Minimum withdraw is 1000 points");
    } else {
      bot.sendMessage(chatId, "✅ Withdrawal request sent to admin");
      users[chatId].balance = 0;
    }

  }

});
