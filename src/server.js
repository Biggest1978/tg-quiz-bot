// src/server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

// ВАЖНО: bot.js НЕ должен запускать long-polling, когда есть WEBHOOK_URL
const bot = require("./bot"); // импортирует уже сконфигурированный bot

const app = express();
app.use(express.json());

// простой healthcheck (Render будет видеть, что порт слушается)
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.send("ok"));

// секретный путь вебхука (чтобы не светить токен)
const token = process.env.TELEGRAM_BOT_TOKEN || "no-token";
const secret = crypto
  .createHash("sha256")
  .update(token)
  .digest("hex")
  .slice(0, 32);
const hookPath = `/tg/${secret}`;

// вешаем обработчик телеги
app.post(hookPath, (req, res) => bot.webhookCallback(hookPath)(req, res));

const PORT = process.env.PORT || 3000;
const BASE = (process.env.WEBHOOK_URL || "").replace(/\/+$/, ""); // без завершающего '/'

app.listen(PORT, async () => {
  console.log(`[server] listening on ${PORT}`);
  if (!BASE) {
    console.log(
      "[server] WEBHOOK_URL пуст. Заполни после первого деплоя и сделай Redeploy."
    );
    return;
  }
  const full = `${BASE}${hookPath}`;
  try {
    await bot.telegram.setWebhook(full);
    console.log("[server] webhook set:", full);
  } catch (e) {
    console.error("[server] setWebhook error:", e.message);
  }
});
