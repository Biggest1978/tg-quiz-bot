// src/analytics.js
// Минимальный клиент аналитики + локальные счётчики,
// чтобы /stats работал даже если Apps Script временно недоступен.

const ANALYTICS_URL = process.env.ANALYTICS_URL || "";
const ANALYTICS_TOKEN = process.env.ANALYTICS_TOKEN || "";

// Локальные счётчики за текущий аптайм процесса
const counters = {
  users: new Set(), // уникальные user_id, кто зашёл в бота
  tg: 0,
  site: 0,
  expo: 0,
  tier0: 0,
  tier1: 0,
  tier2: 0,
};

async function post(event, user_id, data = {}) {
  if (!ANALYTICS_URL || !ANALYTICS_TOKEN) return; // тихо выходим, если не настроено
  try {
    const res = await fetch(ANALYTICS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: ANALYTICS_TOKEN, // в Apps Script сравниваете с ALLOWED_TOKEN
        event, // 'join' | 'link' | 'final'
        user_id,
        data, // { kind: 'tg'|'site'|'expo' } или { tier: 'tier0'|'tier1'|'tier2' }
        ts: Date.now(),
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[analytics] http", res.status, t);
    }
  } catch (e) {
    console.warn("[analytics] error:", e.message);
  }
}

function markJoin(user_id) {
  counters.users.add(user_id);
  post("join", user_id);
}

function link(user_id, kind) {
  if (kind === "tg") counters.tg++;
  if (kind === "site") counters.site++;
  if (kind === "expo") counters.expo++;
  post("link", user_id, { kind });
}

function final(user_id, tier) {
  if (tier === "tier0") counters.tier0++;
  if (tier === "tier1") counters.tier1++;
  if (tier === "tier2") counters.tier2++;
  post("final", user_id, { tier });
}

function stats() {
  return {
    users: counters.users.size,
    tg_clicks: counters.tg,
    site_clicks: counters.site,
    expo_clicks: counters.expo,
    tier0: counters.tier0,
    tier1: counters.tier1,
    tier2: counters.tier2,
  };
}

module.exports = { markJoin, link, final, stats };
