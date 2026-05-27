const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const cron = require("node-cron");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const CHANNEL_LINK = "https://t.me/global_xabar_uz";
const AD_TEXT = `\n\n📢 Obuna bo'ling: ${CHANNEL_LINK}`;

let sentToday = 0;
let lastSent = null;
let isRunning = false;
let botPaused = false;
let startFromTomorrow = false;
const logs = [];
const sentTitles = new Set();
const dailyNews = [];

const settings = {
  kunuz: true, daryo: true, newsapi: true,
  bbcuz: true, gazeta: true, xabar: true,
  podrobno: true, xabarchi: true,
  interval: 2, digestHour: 21,
};

let newsCronJob = null;
let digestCronJob = null;

// AUTH
const ADMIN = { login: "admin", password: "habar123" };
const sessions = new Set();

function authMiddleware(req, res, next) {
  const token = req.headers["x-auth-token"];
  if (sessions.has(token)) return next();
  res.status(401).json({ ok: false, error: "Kirish talab etiladi" });
}

app.post("/api/login", (req, res) => {
  const { login, password } = req.body;
  if (login === ADMIN.login && password === ADMIN.password) {
    const token = Math.random().toString(36).slice(2) + Date.now();
    sessions.add(token);
    res.json({ ok: true, token });
  } else {
    res.json({ ok: false, error: "Login yoki parol noto'g'ri" });
  }
});

function addLog(type, msg) {
  const time = new Date().toLocaleTimeString("uz-UZ");
  logs.unshift({ type, msg, time });
  if (logs.length > 300) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function clearLogs() { logs.length = 0; }

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

function getEmoji(category) {
  const map = {
    sport: "⚽", texnologiya: "💻", iqtisodiyot: "💰",
    siyosat: "🏛️", salomatlik: "🏥", dunyo: "🌍",
  };
  return map[category] || "🌍";
}

function startCronJobs() {
  if (newsCronJob) newsCronJob.stop();
  if (digestCronJob) digestCronJob.stop();
  newsCronJob = cron.schedule(`0 */${settings.interval} * * *`, () => {
    if (botPaused) { addLog("warn", "Bot to'xtatilgan, o'tkazib yuborildi"); return; }
    if (startFromTomorrow) { addLog("info", "Ertadan boshlab rejimi, kutilmoqda..."); return; }
    addLog("info", `Avtomatik yangilik (har ${settings.interval} soat)...`);
    runCycle();
  });
  digestCronJob = cron.schedule(`0 ${settings.digestHour} * * *`, () => {
    if (botPaused) return;
    addLog("info", `Digest vaqti (${settings.digestHour}:00)...`);
    runDigest();
  });
  addLog("info", `Jadval: har ${settings.interval}s | Digest: ${settings.digestHour}:00`);
}

// "Ertadan boshlab" - yarim tunda yoqiladi
cron.schedule("0 0 * * *", () => {
  sentToday = 0;
  dailyNews.length = 0;
  if (startFromTomorrow) {
    startFromTomorrow = false;
    botPaused = false;
    addLog("ok", "Yangi kun — bot ishga tushdi!");
  }
  addLog("info", "Hisoblar nollandi");
});

async function fetchRSS(url, sourceName, lang = "uz") {
  try {
    const res = await fetch(url, { timeout: 8000 });
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return items.slice(0, 15).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
      const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || "";
      const img = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] ||
                  item.match(/<media:content[^>]+url="([^"]+)"/)?.[1] ||
                  item.match(/<media:thumbnail[^>]+url="([^"]+)"/)?.[1] || null;
      return {
        title, description: desc.replace(/<[^>]+>/g, "").trim().slice(0, 300),
        url: link, imageUrl: img, source: sourceName, lang
      };
    }).filter(a => a.title && !sentTitles.has(a.title));
  } catch(e) {
    addLog("warn", `${sourceName}: ` + e.message);
    return [];
  }
}

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
        title: a.title, description: a.description || "",
        url: a.url, imageUrl: a.urlToImage || null,
        source: a.source?.name || "NewsAPI", lang: "en"
      }));
  } catch(e) { addLog("warn", "NewsAPI: " + e.message); return []; }
}

async function fetchAllNews() {
  const promises = [];
  if (settings.kunuz) promises.push(fetchRSS("https://kun.uz/rss", "Kun.uz"));
  if (settings.daryo) promises.push(fetchRSS("https://daryo.uz/feed", "Daryo.uz"));
  if (settings.xabarchi) promises.push(fetchRSS("https://xabarchi.com/feed", "Xabarchi.com"));
  if (settings.gazeta) promises.push(fetchRSS("https://www.gazeta.uz/uz/rss/", "Gazeta.uz"));
  if (settings.xabar) promises.push(fetchRSS("https://xabar.uz/feed", "Xabar.uz"));
  if (settings.bbcuz) promises.push(fetchRSS("https://feeds.bbci.co.uk/uzbek/rss.xml", "BBC O'zbek"));
  if (settings.podrobno) promises.push(fetchRSS("https://podrobno.uz/rss/", "Podrobno.uz", "ru"));
  if (settings.newsapi) promises.push(fetchNewsAPI());
  const results = await Promise.all(promises);
  const all = results.flat();
  if (all.length === 0) throw new Error("Hech qaysi manbadan yangilik topilmadi");
  const uzFirst = all.filter(n => ["Kun.uz","Daryo.uz","Xabarchi.com","Gazeta.uz","Xabar.uz","BBC O'zbek"].includes(n.source));
  const pool = uzFirst.length > 0 ? uzFirst : all;
  return pool[Math.floor(Math.random() * Math.min(6, pool.length))];
}

async function groqRequest(prompt, maxTokens = 700) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7, max_tokens: maxTokens,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error("Groq: " + JSON.stringify(data));
  return data.choices[0].message.content.trim();
}

function cleanText(text) {
  return text
    .replace(/&laquo;/g, '"').replace(/&raquo;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&#[0-9]+;/g, '').replace(/&[a-z]+;/g, '')
    .trim();
}

async function translateWithGroq(news) {
  const isUz = ["Kun.uz","Daryo.uz","Xabarchi.com","Gazeta.uz","Xabar.uz","BBC O'zbek"].includes(news.source);
  const isRu = news.lang === "ru";

  const cleanTitle = cleanText(news.title);
  const cleanDesc = cleanText(news.description);

  const langInstruction = isUz 
    ? "Bu yangilik o'zbek tilida. Aynan o'zbek tilida yoz, ruscha so'z ishlatma."
    : isRu 
    ? "Bu yangilik ruscha. O'ZBEK tiliga to'liq tarjima qil, birorta ruscha so'z qoldirma."
    : "Bu yangilik inglizcha. O'ZBEK tiliga to'liq tarjima qil, birorta inglizcha so'z qoldirma.";

  const prompt = `Sen Telegram kanal muharririsan. ${langInstruction}

Sarlavha: ${cleanTitle}
Tavsif: ${cleanDesc}
Manba: ${news.source}

MUHIM QOIDALAR:
1. FAQAT o'zbek tilida yoz — ruscha yoki inglizcha so'z ISHLATMA
2. Sarlavhani jozibali qil: "🔴 Shok:", "⚡ Tezkor:", "🌍 Muhim:", "📌 Diqqat:", "🔥 Yangilik:" kabilardan birini qo'sh
3. Sarlavhani *yulduzcha* ichida yoz: *🔴 Sarlavha matni*
4. 3-4 jumla, qisqa va qiziqarli
5. 1-2 mos emoji qo'sh
6. Oxirida: "📎 Manba: ${news.source}"
7. Kategoriya: dunyo, sport, iqtisodiyot, siyosat, texnologiya, salomatlik

FAQAT JSON qaytar, boshqa hech narsa yozma:
{"text": "post matni", "category": "kategoriya"}`;

  const raw = await groqRequest(prompt, 700);
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("JSON topilmadi");
  const result = JSON.parse(jsonMatch[0]);
  result.text = cleanText(result.text);
  return result;
}

async function searchTopic(query) {
  const prompt = `Sen o'zbek tilidagi yangiliklar mutaxassisisan. Foydalanuvchi "${query}" haqida ma'lumot so'radi.

Bu mavzu haqida quyidagilarni tayyorla:
1. Qisqa kirish (2 jumla)
2. Asosiy ma'lumotlar (4-5 nuqta, har biri 1-2 jumla)
3. Hozirgi holat (2 jumla)
4. Xulosa (1 jumla)

O'zbek tilida yoz, emoji ishlet, Telegram formatida (*bold*, _italic_).
Oxirida kategoriya: dunyo, sport, iqtisodiyot, siyosat, texnologiya, salomatlik

FAQAT JSON:
{"text": "matn", "category": "kategoriya", "imageQuery": "inglizcha rasm qidiruv so'zi (3 so'z)"}`;

  const raw = await groqRequest(prompt, 1000);
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("JSON topilmadi");
  return JSON.parse(jsonMatch[0]);
}

async function getImage(query) {
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&client_id=YOUR_UNSPLASH_KEY`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.results && data.results.length > 0) return data.results[0].urls.regular;
    return null;
  } catch(e) { return null; }
}

async function getSubscriberCount() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getChatMembersCount?chat_id=${CHANNEL_ID}`);
    const data = await res.json();
    return data.ok ? data.result : null;
  } catch(e) { return null; }
}

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

async function runCycle() {
  if (isRunning) return { ok: false, error: "Jarayon band" };
  if (botPaused) return { ok: false, error: "Bot to'xtatilgan" };
  isRunning = true;
  try {
    addLog("info", "Yangilik qidirilmoqda...");
    const news = await fetchAllNews();
    addLog("info", `[${news.source}] ${news.title.slice(0, 55)}`);
    const translated = await translateWithGroq(news);
    const hashtags = getHashtags(translated.category);
    const finalText = translated.text + "\n\n" + hashtags + AD_TEXT;
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
  } finally { isRunning = false; }
}

async function runDigest() {
  if (isRunning) return { ok: false, error: "Band" };
  if (dailyNews.length === 0) return { ok: false, error: "Bugun hech narsa yuborilmagan" };
  isRunning = true;
  try {
    addLog("info", "Digest tayyorlanmoqda...");
    const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long", year: "numeric" });
    const list = dailyNews.slice(-20).map((n, i) => `${i+1}. ${n}`).join("\n");
    const prompt = `O'zbek Telegram kanali uchun kun yakunini yoz.
Bugun yuborilgan yangiliklar:
${list}

Format:
- Sarlavha: "📰 *Bugun nimalar bo'ldi? — ${today}*"
- Har birini 1-2 jumlada qiziqarli yoz
- O'zbek tilida, emoji bilan
- 15-20 jumla jami
- Oxirida: #digest #bugunyangiliklari

Faqat tayyor post matnini yoz.`;
    const digestText = await groqRequest(prompt, 1500);
    const fullText = digestText + AD_TEXT;
    const result = await sendToTelegram(fullText, null);
    if (result.ok) {
      addLog("ok", "Digest yuborildi!");
      return { ok: true, text: fullText };
    } else throw new Error(result.description);
  } catch(e) {
    addLog("err", "Digest: " + e.message);
    return { ok: false, error: e.message };
  } finally { isRunning = false; }
}

// ROUTES
app.get("/api/status", authMiddleware, async (req, res) => {
  const subs = await getSubscriberCount();
  res.json({
    ok: true, channel: CHANNEL_ID,
    gemini: GROQ_KEY ? "✅" : "❌",
    newsApi: NEWS_API_KEY ? "✅" : "❌",
    bot: BOT_TOKEN ? "✅" : "❌",
    sentToday, lastSent, isRunning, botPaused, startFromTomorrow,
    sentCount: sentTitles.size, dailyCount: dailyNews.length,
    subscribers: subs, settings,
    logs: logs.slice(0, 30),
  });
});

app.post("/api/send-now", authMiddleware, async (req, res) => res.json(await runCycle()));
app.post("/api/digest-now", authMiddleware, async (req, res) => res.json(await runDigest()));
app.post("/api/clear-logs", authMiddleware, (req, res) => { clearLogs(); res.json({ ok: true }); });

app.post("/api/toggle-bot", authMiddleware, (req, res) => {
  const { action } = req.body;
  if (action === "stop") {
    botPaused = true; startFromTomorrow = false;
    addLog("warn", "Bot to'xtatildi");
  } else if (action === "tomorrow") {
    botPaused = true; startFromTomorrow = true;
    addLog("info", "Ertadan boshlab rejimi yoqildi");
  } else {
    botPaused = false; startFromTomorrow = false;
    addLog("ok", "Bot ishga tushdi");
  }
  res.json({ ok: true, botPaused, startFromTomorrow });
});

app.post("/api/search-topic", authMiddleware, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ ok: false, error: "So'rov kerak" });
  try {
    addLog("info", `Qidiruv: "${query}"`);
    const result = await searchTopic(query);
    result.text = result.text + AD_TEXT;
    res.json({ ok: true, ...result });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/send-custom", authMiddleware, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.json({ ok: false, error: "Matn kerak" });
  try {
    const finalText = text + AD_TEXT;
    const result = await sendToTelegram(finalText, imageUrl);
    if (result.ok) { sentToday++; lastSent = new Date().toISOString(); }
    addLog(result.ok ? "ok" : "err", "Qo'lda: " + text.slice(0, 50));
    res.json(result);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post("/api/settings", authMiddleware, (req, res) => {
  const { kunuz, daryo, newsapi, bbcuz, gazeta, xabar, podrobno, xabarchi, interval, digestHour } = req.body;
  const bools = { kunuz, daryo, newsapi, bbcuz, gazeta, xabar, podrobno, xabarchi };
  Object.keys(bools).forEach(k => { if (typeof bools[k] === "boolean") settings[k] = bools[k]; });
  if (interval && [1,2,3,4,6,8,12].includes(Number(interval))) settings.interval = Number(interval);
  if (digestHour && digestHour >= 18 && digestHour <= 23) settings.digestHour = Number(digestHour);
  startCronJobs();
  res.json({ ok: true, settings });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("ok", `Server: http://localhost:${PORT}`);
  addLog("info", `Kanal: ${CHANNEL_ID}`);
  startCronJobs();
  addLog("info", "Manbalar: Kun.uz + Daryo.uz + Xabarchi + Gazeta + Xabar + BBC + Podrobno + NewsAPI");
});