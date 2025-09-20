require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup } = require("telegraf");

/* ---------- загрузка контента ---------- */
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

/* ---------- телеграм-бот ---------- */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Нет TELEGRAM_BOT_TOKEN в .env");
const bot = new Telegraf(token);

/* ---------- простейшее хранилище сессий ---------- */
const sessions = new Map(); // key: userId, value: { deck, i, score, awaiting }

/* ---------- утилиты рендера клавиатур ---------- */
function toInlineKeyboard(buttons = []) {
  const rows = buttons.map((btn) => {
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

/* ---------- рендер «экранов» (старт/призы/начать и т.п.) ---------- */
async function showScreen(ctx, screen) {
  const caption = [
    screen.title ? `<b>${screen.title}</b>` : "",
    screen.text ? screen.text : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return ctx.replyWithPhoto(screen.image_url, {
    caption,
    parse_mode: "HTML",
    ...toInlineKeyboard(screen.buttons),
  });
}

/* ---------- логика выбора колоды ---------- */
function pickDeckForUser(userId) {
  // Явно указан debug-индекс → используем тестовые колоды
  const dbgIdx = process.env.DEBUG_DECK_INDEX;
  if (
    dbgIdx !== undefined &&
    content.debug_decks &&
    content.debug_decks[Number(dbgIdx)]
  ) {
    return [...content.debug_decks[Number(dbgIdx)]];
  }

  // По умолчанию — РАБОЧИЕ колоды из pool
  const pool = content.deck_pool || [];
  if (!pool.length)
    throw new Error(
      "deck_pool пуст — добавьте рабочие колоды в game_content.json"
    );
  const rand = Math.floor(Math.random() * pool.length);
  return [...pool[rand]];
}

function findCard(id) {
  return content.cards.find((c) => c.card_id === id);
}

/* ---------- ИГРА ---------- */
async function startGame(ctx) {
  const uid = ctx.from.id;
  const deck = pickDeckForUser(uid);
  sessions.set(uid, { deck, i: 0, score: 0, awaiting: false });
  await sendQuestion(ctx);
}

/** Шапка + вопрос жирным + гарантированные пустые строки между A/B/C/D */
function buildQuestionCaption(card, index, total) {
  const header = `<b>Вопрос ${index + 1}/${total}</b>`;
  const title = `<b>${card.question}</b>`;
  const opts = (card.options || [])
    // добавляем пустую строку после A, B, C (D без хвоста)
    .map((opt, i, arr) => (i < arr.length - 1 ? `${opt}\n` : opt))
    .join("\n");
  return [header, title, "", opts].join("\n");
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
  if (!s || !s.awaiting) return;

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

  await ctx.replyWithPhoto(ui?.image_url, {
    caption,
    parse_mode: "HTML",
    ...(ui?.buttons ? toInlineKeyboard(ui.buttons) : {}),
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

  if (!tier) return ctx.reply(`Ваш результат: ${score}/${qTotal}`);

  const title = tier.title
    ? tier.title.replace("{score}", score).replace("{q_total}", qTotal)
    : "";
  const text = tier.text
    ? tier.text.replace("{score}", score).replace("{q_total}", qTotal)
    : "";

  const caption = [title ? `<b>${title}</b>` : "", text]
    .filter(Boolean)
    .join("\n\n");

  await ctx.replyWithPhoto(tier.image_url, {
    caption,
    parse_mode: "HTML",
    ...(tier.buttons ? toInlineKeyboard(tier.buttons) : {}),
  });

  sessions.delete(uid);
}

bot.action(/^cmd:final$/, async (ctx) => {
  await ctx.answerCbQuery();
  return showFinal(ctx);
});

/* ---------- обработчики стартовых экранов ---------- */
bot.start(async (ctx) => {
  await showScreen(ctx, content.screens.start);
});

if (
  Array.isArray(content.settings?.start_synonyms) &&
  content.settings.start_synonyms.length
) {
  const syn = new RegExp(content.settings.start_synonyms.join("|"), "i");
  bot.hears(syn, async (ctx) => {
    await showScreen(ctx, content.screens.start);
  });
}

bot.action(/^screen:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const screen = content.screens[id];
  if (screen) return showScreen(ctx, screen);
});

bot.action(/^cmd:go$/, async (ctx) => {
  await ctx.answerCbQuery();
  await startGame(ctx);
});

/* ---------- полезная команда ---------- */
bot.command("whoami", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

/* ---------- ловим ошибки ---------- */
bot.catch((err) => console.error("Bot error:", err));

/* ---------- запуск ---------- */
bot.launch().then(() => console.log("Bot started (long-polling)"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
