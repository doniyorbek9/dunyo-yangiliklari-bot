const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const cron = require("node-cron");
require("dotenv").config();

const app = express();
app.use(express.json());

// ── Login himoyasi ──────────────────────────────────────────────
const LOGIN = "admin";
const PASSWORD = "habar123";
const sessions = new Set();

function authMiddleware(req, res, next) {
  const token = req.headers["x-auth-token"] || req.query.token;
  if (sessions.has(token)) return next();
  res.status(401).json({ ok: false, error: "Kirish talab etiladi" });
}

app.post("/api/login", (req, res) => {
  const { login, password } = req.body;
  if (login === LOGIN && password === PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.add(token);
    res.json({ ok: true, token });
  } else {
    res.json({ ok: false, error: "Login yoki parol noto'g'ri" });
  }
});

app.use("/api/status", (req, res, next) => {
  const token = req.headers["x-auth-token"] || req.query.token;
  if (sessions.has(token)) return next();
  res.status(401).json({ ok: false, error: "Kirish talab etiladi" });
});

// Static fayllar login tekshiruvsiz (index.html uchun)
app.use(express.static("public"));

// ── O'zgaruvchilar ──────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

let sentToday = 0;
let lastSent = null;
let isRunning = false;
let botPaused = false;       // To'xtatilgan holat
let scheduleMode = "normal"; // "normal" | "every1h"
const logs = [];
const sentTitles = new Set();
const dailyNews = [];

const settings = {
  kunuz: true,
  daryo: true,
  newsapi: true,
  bbcuz: true,
  gazetauz: true,
  xabaruz: true,
  podrobno: true,
  interval: 2,
  digestHour: 21,
};

let newsCronJob = null;
let digestCronJob = null;
let every1hJob = null;

function addLog(type, msg) {
  const time = new Date().toLocaleTimeString("uz-UZ");
  logs.unshift({ type, msg, time });
  if (logs.length > 200) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ── Kiziqarli sarlavha uchun emoji va qo'shimcha so'zlar ──────
function getHashtags(category) {
  const map = {
    sport: "#sport #yangilik",
    texnologiya: "#texnologiya #tech",
    iqtisodiyot: "#iqtisodiyot #moliya",
    siyosat: "#siyosat #dunyo",
    salomatlik: "#salomatlik #tibbiyot",
    dunyo: "#dunyo #xabar",
  };
  return map[category] || "#dunyo #yangilik";
}

// ── Cron ────────────────────────────────────────────────────────
function startCronJobs() {
  if (newsCronJob) newsCronJob.stop();
  if (digestCronJob) digestCronJob.stop();
  if (every1hJob) { every1hJob.stop(); every1hJob = null; }

  scheduleMode = "normal";

  const newsPattern = `0 */${settings.interval} * * *`;
  newsCronJob = cron.schedule(newsPattern, () => {
    if (botPaused) return addLog("info", "Bot to'xtatilgan, o'tkazib yuborildi");
    addLog("info", `Avtomatik yangilik (har ${settings.interval} soat)...`);
    runCycle();
  });

  const digestPattern = `0 ${settings.digestHour} * * *`;
  digestCronJob = cron.schedule(digestPattern, () => {
    if (botPaused) return;
    addLog("info", `Digest vaqti (${settings.digestHour}:00)...`);
    runDigest();
  });

  addLog("info", `Jadval: har ${settings.interval} soat | Digest: ${settings.digestHour}:00`);
}

function startEvery1h() {
  if (newsCronJob) newsCronJob.stop();
  if (every1hJob) every1hJob.stop();

  scheduleMode = "every1h";
  every1hJob = cron.schedule("0 * * * *", () => {
    if (botPaused) return addLog("info", "Bot to'xtatilgan");
    addLog("info", "Har soatlik avtomatik yangilik...");
    runCycle();
  });
  addLog("info", "Rejim: har 1 soatda yuborish yoqildi");
}

// ── Manbalar ────────────────────────────────────────────────────
async function fetchNewsAPI() {
  if (!settings.newsapi) return [];
  try {
    const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=20&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.articles) return [];
    return data.articles
      .filter(a => a.title && a.description && !sentTitles.has(a.title))
      .map(a => ({
        title: a.title,
        description: a.description || "",
        url: a.url,
        imageUrl: a.urlToImage || null,
        source: a.source?.name || "NewsAPI",
        lang: "en",
      }));
  } catch(e) {
    addLog("warn", "NewsAPI: " + e.message);
    return [];
  }
}

async function fetchRSS(url, sourceName, lang = "uz") {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return items.slice(0, 15).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
      const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || "";
      const img = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] ||
                  item.match(/<media:content[^>]+url="([^"]+)"/)?.[1] || null;
      const cleanDesc = desc.replace(/<[^>]+>/g, "").trim().slice(0, 300);
      return { title, description: cleanDesc, url: link, imageUrl: img, source: sourceName, lang };
    }).filter(a => a.title && !sentTitles.has(a.title));
  } catch(e) {
    addLog("warn", `${sourceName}: ` + e.message);
    return [];
  }
}

async function fetchAllNews() {
  const promises = [];
  if (settings.kunuz)    promises.push(fetchRSS("https://kun.uz/rss", "Kun.uz", "uz"));
  if (settings.daryo)    promises.push(fetchRSS("https://daryo.uz/feed", "Daryo.uz", "uz"));
  if (settings.bbcuz)    promises.push(fetchRSS("https://feeds.bbci.co.uk/uzbek/rss.xml", "BBC Uzbek", "uz"));
  if (settings.gazetauz) promises.push(fetchRSS("https://www.gazeta.uz/rss/", "Gazeta.uz", "uz"));
  if (settings.xabaruz)  promises.push(fetchRSS("https://xabar.uz/feed", "Xabar.uz", "uz"));
  if (settings.podrobno) promises.push(fetchRSS("https://podrobno.uz/rss.xml", "Podrobno.uz", "ru"));
  if (settings.newsapi)  promises.push(fetchNewsAPI());

  const results = await Promise.all(promises);
  const all = results.flat();
  if (all.length === 0) throw new Error("Hech qaysi manbadan yangilik topilmadi");

  // O'zbek/RU manbalarni afzal ko'r
  const uzNews = all.filter(n => ["Kun.uz","Daryo.uz","BBC Uzbek","Gazeta.uz","Xabar.uz","Podrobno.uz"].includes(n.source));
  const pool = uzNews.length > 0 ? uzNews : all;
  return pool[Math.floor(Math.random() * Math.min(5, pool.length))];
}

// ── Groq AI ─────────────────────────────────────────────────────
async function groqRequest(prompt, maxTokens = 700) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: maxTokens,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error("Groq: " + JSON.stringify(data));
  return data.choices[0].message.content.trim();
}

async function translateWithGroq(news) {
  const isUzbek = ["Kun.uz","Daryo.uz","BBC Uzbek","Gazeta.uz","Xabar.uz"].includes(news.source);
  const isRussian = news.source === "Podrobno.uz";

  const langNote = isUzbek
    ? "Quyidagi o'zbek tilidagi yangilikni"
    : isRussian
    ? "Quyidagi rus tilidagi yangilikni o'zbekchaga tarjima qilib"
    : "Quyidagi inglizcha yangilikni o'zbekchaga tarjima qilib";

  const prompt = `Sen Telegram kanal uchun qiziqarli yangilik yozuvchisan. ${langNote} Telegram post qilib chiqar.

Sarlavha: ${news.title}
Tavsif: ${news.description}

MUHIM QOIDALAR:
1. Sarlavhani *yulduzcha* ichida yoz: *Sarlavha matni*
   - Sarlavha JUDA QIZIQARLI, hayratlanarli yoki shoshilinch tuyulishi kerak
   - Masalan: "😱 Dunyo larzaga keldi!", "🔥 Kutilmagan voqea!", "⚡ Shoshilinch xabar!" kabi boshla
   - Sarlavhada kuchli his-tuyg'u uyg'otuvchi so'zlar ishlatl
2. 3-4 jumla yoz, qisqa va tushunarli
3. 2-3 ta mos emoji qo'sh
4. Oxirida: "📎 Manba: ${news.source}"
5. Kategoriya: dunyo, sport, iqtisodiyot, siyosat, texnologiya yoki salomatlik

FAQAT quyidagi JSON formatda javob ber, boshqa hech narsa yozma:
{"text": "post matni bu yerga", "category": "kategoriya"}`;

  const raw = await groqRequest(prompt, 700);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("JSON topilmadi: " + raw.slice(0, 100));
  return JSON.parse(jsonMatch[0]);
}

async function generateDigest() {
  if (dailyNews.length === 0) throw new Error("Bugun hech narsa yuborilmagan");
  const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long", year: "numeric" });
  const list = dailyNews.slice(-20).map((n, i) => `${i+1}. ${n}`).join("\n");

  const prompt = `Sen O'zbek Telegram kanali uchun kun yakunini yozuvchisan.

Bugun yuborilgan yangiliklar:
${list}

Quyidagi formatda "Bugun nimalar bo'ldi?" digest yoz:
- Sarlavha: "📰 *Bugun nimalar bo'ldi? — ${today}*"
- Har bir yangilikni 1-2 jumlada qiziqarli tarzda yoz
- O'zbek tilida yoz
- Umumiy 15-20 jumla
- Oxirida: #digest #bugunyangiliklari

Faqat tayyor post matnini yoz, boshqa izoh yozma.`;

  return await groqRequest(prompt, 1500);
}

// ── Telegram ─────────────────────────────────────────────────────
async function sendToTelegram(text, imageUrl) {
  if (imageUrl) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHANNEL_ID, photo: imageUrl, caption: text, parse_mode: "Markdown" }),
    });
    const d = await res.json();
    if (!d.ok) return sendToTelegram(text, null);
    return d;
  }
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL_ID, text, parse_mode: "Markdown" }),
  });
  return res.json();
}

// ── Asosiy sikl ──────────────────────────────────────────────────
async function runCycle() {
  if (isRunning) return { ok: false, error: "Jarayon band, kuting..." };
  isRunning = true;
  try {
    addLog("info", "Yangilik qidirilmoqda...");
    const news = await fetchAllNews();
    addLog("info", `[${news.source}] ${news.title.slice(0, 55)}`);
    addLog("info", "Groq tarjima qilmoqda...");
    const translated = await translateWithGroq(news);
    const hashtags = getHashtags(translated.category);
    const finalText = translated.text + "\n\n" + hashtags;
    addLog("info", "Telegramga yuborilmoqda...");
    const result = await sendToTelegram(finalText, news.imageUrl);
    if (result.ok) {
      sentTitles.add(news.title);
      if (sentTitles.size > 500) sentTitles.delete(sentTitles.values().next().value);
      dailyNews.push(news.title);
      sentToday++;
      lastSent = new Date().toISOString();
      addLog("ok", `[${news.source}] Yuborildi ✓`);
      return { ok: true, text: finalText, category: translated.category, source: news.source };
    } else {
      throw new Error(result.description);
    }
  } catch(e) {
    addLog("err", "Xato: " + e.message);
    return { ok: false, error: e.message };
  } finally {
    isRunning = false;
  }
}

async function runDigest() {
  if (isRunning) return { ok: false, error: "Band" };
  isRunning = true;
  try {
    addLog("info", "Digest tayyorlanmoqda...");
    const digestText = await generateDigest();
    const result = await sendToTelegram(digestText, null);
    if (result.ok) {
      addLog("ok", "Digest yuborildi!");
      return { ok: true, text: digestText };
    } else {
      throw new Error(result.description);
    }
  } catch(e) {
    addLog("err", "Digest xato: " + e.message);
    return { ok: false, error: e.message };
  } finally {
    isRunning = false;
  }
}

// Har kuni nollash
cron.schedule("0 0 * * *", () => {
  sentToday = 0;
  dailyNews.length = 0;
  addLog("info", "Yangi kun — hisoblar nollandi");
});

// ── API endpointlar ──────────────────────────────────────────────
app.get("/api/status", authMiddleware, (req, res) => {
  res.json({
    ok: true,
    channel: CHANNEL_ID,
    gemini: GROQ_KEY ? "✅" : "❌",
    newsApi: NEWS_API_KEY ? "✅" : "❌",
    bot: BOT_TOKEN ? "✅" : "❌",
    sentToday, lastSent, isRunning,
    botPaused,
    scheduleMode,
    sentCount: sentTitles.size,
    dailyCount: dailyNews.length,
    settings,
    logs: logs.slice(0, 30),
  });
});

app.post("/api/send-now", authMiddleware, async (req, res) => res.json(await runCycle()));
app.post("/api/digest-now", authMiddleware, async (req, res) => res.json(await runDigest()));

app.post("/api/pause", authMiddleware, (req, res) => {
  botPaused = true;
  addLog("warn", "Bot to'xtatildi ⏸");
  res.json({ ok: true, botPaused });
});

app.post("/api/resume-tomorrow", authMiddleware, (req, res) => {
  // Ertasi kuni ertalab 08:00 da qayta yoqish
  const now = new Date();
  const tomorrow8 = new Date(now);
  tomorrow8.setDate(tomorrow8.getDate() + 1);
  tomorrow8.setHours(8, 0, 0, 0);
  const msUntil = tomorrow8 - now;

  botPaused = true;
  addLog("warn", `Bot to'xtatildi. Ertaga 08:00 da qayta yoqiladi (${Math.round(msUntil/3600000)} soatdan so'ng)`);

  setTimeout(() => {
    botPaused = false;
    addLog("ok", "Bot ertadan boshlab qayta yoqildi ▶️");
  }, msUntil);

  res.json({ ok: true, resumeAt: tomorrow8.toISOString() });
});

app.post("/api/resume", authMiddleware, (req, res) => {
  botPaused = false;
  addLog("ok", "Bot qayta yoqildi ▶️");
  res.json({ ok: true, botPaused });
});

app.post("/api/schedule-every1h", authMiddleware, (req, res) => {
  startEvery1h();
  res.json({ ok: true, scheduleMode: "every1h" });
});

app.post("/api/schedule-normal", authMiddleware, (req, res) => {
  startCronJobs();
  res.json({ ok: true, scheduleMode: "normal" });
});

app.post("/api/send-custom", authMiddleware, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.json({ ok: false, error: "Matn kerak" });
  try {
    const result = await sendToTelegram(text, imageUrl);
    if (result.ok) { sentToday++; lastSent = new Date().toISOString(); }
    addLog(result.ok ? "ok" : "err", "Qo'lda: " + text.slice(0, 50));
    res.json(result);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post("/api/settings", authMiddleware, (req, res) => {
  const { kunuz, daryo, newsapi, bbcuz, gazetauz, xabaruz, podrobno, interval, digestHour } = req.body;
  if (typeof kunuz === "boolean") settings.kunuz = kunuz;
  if (typeof daryo === "boolean") settings.daryo = daryo;
  if (typeof newsapi === "boolean") settings.newsapi = newsapi;
  if (typeof bbcuz === "boolean") settings.bbcuz = bbcuz;
  if (typeof gazetauz === "boolean") settings.gazetauz = gazetauz;
  if (typeof xabaruz === "boolean") settings.xabaruz = xabaruz;
  if (typeof podrobno === "boolean") settings.podrobno = podrobno;
  if (interval && [1, 2, 3, 4, 6, 8, 12].includes(Number(interval))) {
    settings.interval = Number(interval);
  }
  if (digestHour && digestHour >= 18 && digestHour <= 23) {
    settings.digestHour = Number(digestHour);
  }
  startCronJobs();
  addLog("info", `Sozlamalar saqlandi: ${settings.interval}s | digest ${settings.digestHour}:00`);
  res.json({ ok: true, settings });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("ok", `Server: http://localhost:${PORT}`);
  addLog("info", `Kanal: ${CHANNEL_ID}`);
  startCronJobs();
  addLog("info", "Manbalar: Kun.uz + Daryo.uz + BBC Uzbek + Gazeta.uz + Xabar.uz + Podrobno.uz + NewsAPI");
});
