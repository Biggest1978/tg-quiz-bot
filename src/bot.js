const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { Telegraf, Markup } = require("telegraf");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Нет TELEGRAM_BOT_TOKEN в .env");

const bot = new Telegraf(token);

// ЛОГ: видим каждый текст, который приходит боту
bot.use((ctx, next) => {
  if (ctx.message?.text) {
    console.log(">> text:", JSON.stringify(ctx.message.text));
  }
  return next();
});

// Клавиатура со строкой кнопок
const kb = Markup.keyboard([["Поехали ▶️", "Начать игру ▶️"]]).resize();

// /start
bot.start((ctx) =>
  ctx.reply(
    "Привет! Я жив и готов к работе.\nНажми «Поехали ▶️» или «Начать игру ▶️».",
    kb
  )
);

// НОРМАЛИЗАЦИЯ текста (убираем эмодзи/знаки, приводим к нижнему регистру)
const norm = (t = "") =>
  t
    .normalize("NFKD")
    .replace(/[\u{FE0F}\u{200D}\p{P}\p{S}]/gu, "") // эмодзи/знаки/символы
    .trim()
    .toLowerCase();

// Универсальный обработчик кнопок/ввода
bot.on("text", (ctx) => {
  const t = norm(ctx.message.text);
  if (t.startsWith("поехали") || t.startsWith("начать игру") || t === "старт") {
    return ctx.reply(
      "Отлично! Локальный запуск работает. Переходим к следующим шагам."
    );
  }
});

// Вспомогательная команда
bot.command("whoami", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

bot.catch((err) => console.error("Bot error:", err));
bot.launch().then(() => console.log("Bot started (long-polling)"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
