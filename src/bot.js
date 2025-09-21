require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

/* ---------- helpers ---------- */
const bool = (v) => /^true$/i.test(String(v || ""));
const USE_DEBUG = bool(process.env.DEBUG_USE_DEBUG_DECK);
const ANALYTICS_URL = process.env.ANALYTICS_URL || "";
const ANALYTICS_TOKEN = process.env.ANALYTICS_TOKEN || "";

/* ---------- load content ---------- */
const CANDIDATE_PATHS = [
  path.join(__dirname, "game_content.json"),
  path.join(__dirname, "..", "media", "game_content.json"),
  path.join(process.cwd(), "src", "game_content.json"),
  path.join(process.cwd(), "media", "game_content.json"),
];

let content = null;
for (const p of CANDIDATE_PATHS) {
  if (fs.existsSync(p)) {
    content = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log("[content] loaded from:", p);
    break;
  }
}
if (!content) {
  console.error(
    "[content] game_content.json not found. Put it into src/ or media/."
  );
  process.exit(1);
}

/* ---------- bot ---------- */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Нет TELEGRAM_BOT_TOKEN в .env");

const bot = new Telegraf(token);
const sessions = new Map(); // userId -> { deck, i, score, awaiting }

/* ---------- analytics ---------- */
async function track(ev, payload = {}) {
  if (!ANALYTICS_URL || !ANALYTICS_TOKEN) return;
  try {
    await fetch(ANALYTICS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ANALYTICS_TOKEN, event: ev, ...payload }),
    });
  } catch (e) {
    console.error("[analytics] failed:", e.message);
  }
}

/* ---------- keyboards ---------- */
function toInlineKeyboard(buttons = [], uid = null) {
  const rows = (buttons || []).map((btn) => {
    if (btn.type === "url") return [Markup.button.url(btn.label, btn.url)];
    if (btn.type === "screen")
      return [Markup.button.callback(btn.label, `screen:${btn.id}`)];
    if (btn.type === "command")
      return [Markup.button.callback(btn.label, `cmd:${btn.id}`)];
    return [];
  });
  return Markup.inlineKeyboard(rows);
}

function abcdKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("A", "ans:A"),
      Markup.button.callback("B", "ans:B"),
    ],
    [
      Markup.button.callback("C", "ans:C"),
      Markup.button.callback("D", "ans:D"),
    ],
  ]);
}

/* ---------- screens ---------- */
async function showScreen(ctx, screen) {
  const uid = ctx.from.id;
  const caption = [
    screen.title ? `<b>${screen.title}</b>` : "",
    screen.text ? screen.text : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  await ctx.sendChatAction("upload_photo");

  return ctx.replyWithPhoto(screen.image_url, {
    caption,
    parse_mode: "HTML",
    ...toInlineKeyboard(screen.buttons, uid),
  });
}

/* быстрый старт — без падений по ctx в таймере */
async function showStartFast(ctx) {
  const uid = ctx.from.id;
  const screen = content.screens.start;

  const caption = [
    screen.title ? `<b>${screen.title}</b>` : "",
    screen.text ? screen.text : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Моментальный «пинг»
  const ack = await ctx.reply("Запускаю викторину...");
  const chatId = ctx.chat.id;
  const ackId = ack.message_id;

  await ctx.sendChatAction("upload_photo");
  await ctx.replyWithPhoto(screen.image_url, {
    caption,
    parse_mode: "HTML",
    ...toInlineKeyboard(screen.buttons, uid),
  });

  setTimeout(() => {
    bot.telegram.deleteMessage(chatId, ackId).catch(() => {});
  }, 4000);
}

/* ---------- deck selection ---------- */
function pickDeckForUser() {
  console.log(`[deck] mode=${USE_DEBUG ? "DEBUG" : "PROD"}`);
  if (
    USE_DEBUG &&
    Array.isArray(content.debug_decks) &&
    content.debug_decks.length
  ) {
    const idx = Number(process.env.DEBUG_DECK_INDEX);
    const deck =
      Number.isFinite(idx) && content.debug_decks[idx]
        ? content.debug_decks[idx]
        : content.debug_decks[0];
    console.log("[deck] debug deck chosen:", deck.join(", "));
    return [...deck];
  }
  const pool = content.deck_pool || [];
  const rand = Math.floor(Math.random() * pool.length);
  const deck = pool[rand] || [];
  console.log("[deck] prod deck chosen:", deck.join(", "));
  return [...deck];
}

function findCard(id) {
  return content.cards.find((c) => c.card_id === id);
}

/* ---------- game ---------- */
async function startGame(ctx) {
  const uid = ctx.from.id;
  const deck = pickDeckForUser();
  sessions.set(uid, { deck, i: 0, score: 0, awaiting: false });

  const ack = await ctx.reply("Запускаем викторину…");
  const chatId = ctx.chat.id;
  const ackId = ack.message_id;

  sendQuestion(ctx).finally(() => {
    setTimeout(() => {
      bot.telegram.deleteMessage(chatId, ackId).catch(() => {});
    }, 5000);
  });
}

function buildQuestionCaption(card, idx, total) {
  const header = `<b>Вопрос ${idx + 1}/${total}</b>`;
  const title = `<b>${card.question}</b>`;
  const opts = (card.options || []).join("\n\n");
  return [header, title, opts].join("\n\n");
}

async function sendQuestion(ctx) {
  const uid = ctx.from.id;
  const s = sessions.get(uid);
  if (!s) return;

  const qTotal = content.settings?.q_total ?? 10;
  if (s.i >= qTotal || s.i >= s.deck.length) return showFinal(ctx);

  const cardId = s.deck[s.i];
  const card = findCard(cardId);
  if (!card) {
    s.i += 1;
    return sendQuestion(ctx);
  }

  s.awaiting = true;

  const caption = buildQuestionCaption(card, s.i, qTotal);
  await ctx.sendChatAction("upload_photo");
  await ctx.replyWithPhoto(card.image_url, {
    caption,
    parse_mode: "HTML",
    ...abcdKeyboard(),
  });
}

bot.action(/^ans:([ABCD])$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const s = sessions.get(uid);
  if (!s) return;
  if (!s.awaiting) return;

  s.awaiting = false;

  const qTotal = content.settings?.q_total ?? 10;
  const cardId = s.deck[s.i];
  const card = findCard(cardId);
  const userAns = ctx.match[1];

  const isCorrect = userAns === card.correct;
  if (isCorrect) s.score += 1;

  const last = s.i >= qTotal - 1 || s.i >= s.deck.length - 1;
  const ui = isCorrect
    ? last
      ? content.cards_ui?.correct_last
      : content.cards_ui?.correct_more
    : last
    ? content.cards_ui?.wrong_last
    : content.cards_ui?.wrong_more;

  const text = (ui?.text || "")
    .replace("{score}", String(s.score))
    .replace("{q_total}", String(qTotal))
    .replace("{correct_text}", card.correct_text || "");

  const caption = [ui?.title ? `<b>${ui.title}</b>` : "", text]
    .filter(Boolean)
    .join("\n\n");

  await ctx.sendChatAction("upload_photo");
  await ctx.replyWithPhoto(ui?.image_url, {
    caption,
    parse_mode: "HTML",
    ...(ui?.buttons ? toInlineKeyboard(ui.buttons, uid) : {}),
  });
});

bot.action(/^cmd:next$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const s = sessions.get(uid);
  if (!s) return;
  s.i += 1;
  await sendQuestion(ctx);
});

async function showFinal(ctx) {
  const uid = ctx.from.id;
  const s = sessions.get(uid);
  if (!s) return;

  const score = s.score;
  const qTotal = content.settings?.q_total ?? 10;

  const tiers = content.final_routes || {};
  const tier =
    Object.values(tiers).find(
      (t) =>
        Array.isArray(t.range) && score >= t.range[0] && score <= t.range[1]
    ) || null;

  if (!tier) {
    await ctx.reply(`Ваш результат: ${score}/${qTotal}`);
    sessions.delete(uid);
    return;
  }

  const title = (tier.title || "")
    .replace("{score}", score)
    .replace("{q_total}", qTotal);
  const text = (tier.text || "")
    .replace("{score}", score)
    .replace("{q_total}", qTotal);
  const caption = [title ? `<b>${title}</b>` : "", text]
    .filter(Boolean)
    .join("\n\n");

  await ctx.sendChatAction("upload_photo");
  await ctx.replyWithPhoto(tier.image_url, {
    caption,
    parse_mode: "HTML",
    ...(tier.buttons ? toInlineKeyboard(tier.buttons, uid) : {}),
  });

  let tierKey = 0;
  if (tiers.tier2 && score >= tiers.tier2.range[0]) tierKey = 2;
  else if (tiers.tier1 && score >= tiers.tier1.range[0]) tierKey = 1;
  track("final", { user_id: uid, score, q_total: qTotal, tier: tierKey });

  sessions.delete(uid);
}

bot.action(/^cmd:final$/, async (ctx) => {
  await ctx.answerCbQuery();
  return showFinal(ctx);
});

/* ---------- start & synonyms ---------- */
bot.start(async (ctx) => {
  track("join", { user_id: ctx.from.id, joined_at: new Date().toISOString() });
  await showStartFast(ctx);
});

if (
  Array.isArray(content.settings?.start_synonyms) &&
  content.settings.start_synonyms.length
) {
  const syn = new RegExp(content.settings.start_synonyms.join("|"), "i");
  bot.hears(syn, async (ctx) => {
    track("join", {
      user_id: ctx.from.id,
      joined_at: new Date().toISOString(),
    });
    await showStartFast(ctx);
  });
}

/* ---------- screen routing ---------- */
bot.action(/^screen:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  if (id === "start") return showStartFast(ctx);
  const screen = content.screens[id];
  if (screen) return showScreen(ctx, screen);
});

bot.action(/^cmd:go$/, async (ctx) => {
  await ctx.answerCbQuery();
  await startGame(ctx);
});

/* ---------- admin ---------- */
const ADMIN_ID = Number(process.env.ADMIN_USER_ID || 0);
bot.command("whoami", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));
bot.command("stats", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply(`Runtime stats: active sessions = ${sessions.size}`);
});

/* ---------- errors & launch ---------- */
bot.catch((err) => console.error("Bot error:", err));

const USE_WEBHOOK = !!(
  process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.trim()
);

// Если WEBHOOK_URL не задан — работаем в long-polling (локально, dev)
// На Render (как Web Service) WEBHOOK_URL будет задан, и запустится server.js
if (!USE_WEBHOOK) {
  bot.launch().then(() => console.log("Bot started (long-polling)"));
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

module.exports = bot;

// --- tiny HTTP server for health/keep-alive ---
try {
  const express = require("express");
  const app = express();
  app.get("/", (_, res) => res.send("ok"));
  app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`[http] listening on ${PORT}`));
} catch (e) {
  console.log("[http] express not available, skip:", e.message);
}
