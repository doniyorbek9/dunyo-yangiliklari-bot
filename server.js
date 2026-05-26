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
const AUTO_INTERVAL = process.env.AUTO_INTERVAL || "0 */2 * * *";
const DIGEST_TIME = process.env.DIGEST_TIME || "0 21 * * *";

let sentToday = 0;
let lastSent = null;
let isRunning = false;
const logs = [];
const sentTitles = new Set();
const dailyNews = [];

const settings = {
  kunuz: true,
  daryo: true,
  newsapi: true,
  interval: "0 */2 * * *",
  digestTime: "21:00",
};

function addLog(type, msg) {
  const time = new Date().toLocaleTimeString("uz-UZ");
  logs.unshift({ type, msg, time });
  if (logs.length > 200) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

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
      }));
  } catch(e) {
    addLog("warn", "NewsAPI xato: " + e.message);
    return [];
  }
}

async function fetchRSS(url, sourceName) {
  try {
    const res = await fetch(url, { timeout: 8000 });
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return items.slice(0, 15).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
      const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || "";
      const img = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] ||
                  item.match(/<media:content[^>]+url="([^"]+)"/)?.[1] || null;
      const cleanDesc = desc.replace(/<[^>]+>/g, "").trim().slice(0, 300);
      return { title, description: cleanDesc, url: link, imageUrl: img, source: sourceName };
    }).filter(a => a.title && !sentTitles.has(a.title));
  } catch(e) {
    addLog("warn", `${sourceName} xato: ` + e.message);
    return [];
  }
}

async function fetchAllNews() {
  const promises = [];
  if (settings.kunuz) promises.push(fetchRSS("https://kun.uz/rss", "Kun.uz"));
  if (settings.daryo) promises.push(fetchRSS("https://daryo.uz/feed", "Daryo.uz"));
  if (settings.newsapi) promises.push(fetchNewsAPI());

  const results = await Promise.all(promises);
  const all = results.flat();
  if (all.length === 0) throw new Error("Hech qaysi manbadan yangilik topilmadi");

  const uzNews = all.filter(n => n.source === "Kun.uz" || n.source === "Daryo.uz");
  const pool = uzNews.length > 0 ? uzNews : all;
  return pool[Math.floor(Math.random() * Math.min(5, pool.length))];
}

async function translateWithGroq(news) {
  const isUzbek = news.source === "Kun.uz" || news.source === "Daryo.uz";
  const prompt = isUzbek
    ? `Bu o'zbek tilidagi yangilikni Telegram post qilib chiqar. Sarlavhani *bold* qil, 3-4 jumla, 1-2 emoji. Manba oxirida: "📎 ${news.source}". Faqat JSON: {"text":"...","category":"dunyo|sport|iqtisodiyot|siyosat|texnologiya|salomatlik"}
Sarlavha: ${news.title}
Tavsif: ${news.description}`
    : `Bu inglizcha yangilikni o'zbekchaga tarjima qil, Telegram post qilib chiqar. Sarlavhani *bold* qil, 3-4 jumla, 1-2 emoji. Manba oxirida: "📎 ${news.source}". Faqat JSON: {"text":"...","category":"dunyo|sport|iqtisodiyot|siyosat|texnologiya|salomatlik"}
Sarlavha: ${news.title}
Tavsif: ${news.description}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error("Groq: " + JSON.stringify(data));
  const raw = data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

async function generateDigest() {
  if (dailyNews.length === 0) throw new Error("Bugun hech narsa yuborilmagan");
  const list = dailyNews.slice(-20).map((n, i) => `${i+1}. ${n}`).join("\n");
  const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long", year: "numeric" });

  const prompt = `Quyidagi yangiliklardan bugungi kun yakuniy digestini yoz. O'zbek tilida, qiziqarli va informativ. Har bir yangilikning asosiy mohiyatini 1-2 jumlada yoz. Sarlavha: "📰 *Bugun nimalar bo'ldi? — ${today}*". Heshteg oxirida: #digest #bugun. Jami 15-20 jumla.

Yangiliklar:
${list}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 1500,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error("Groq digest: " + JSON.stringify(data));
  return data.choices[0].message.content.trim();
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

// Har kuni yarim tunda kunlik hisobni nollash
cron.schedule("0 0 * * *", () => {
  sentToday = 0;
  dailyNews.length = 0;
  addLog("info", "Yangi kun boshlandi, hisoblar nollandi");
});

// Yangilik yuborish
cron.schedule(AUTO_INTERVAL, () => {
  addLog("info", "Avtomatik yangilik...");
  runCycle();
});

// Kun digest 21:00
cron.schedule(DIGEST_TIME, () => {
  addLog("info", "Digest vaqti keldi...");
  runDigest();
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    channel: CHANNEL_ID,
    gemini: GROQ_KEY ? "✅" : "❌",
    newsApi: NEWS_API_KEY ? "✅" : "❌",
    bot: BOT_TOKEN ? "✅" : "❌",
    sentToday, lastSent, isRunning,
    autoInterval: AUTO_INTERVAL,
    digestTime: DIGEST_TIME,
    sentCount: sentTitles.size,
    dailyCount: dailyNews.length,
    settings,
    logs: logs.slice(0, 30),
  });
});

app.post("/api/send-now", async (req, res) => res.json(await runCycle()));
app.post("/api/digest-now", async (req, res) => res.json(await runDigest()));

app.post("/api/send-custom", async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.json({ ok: false, error: "Matn kerak" });
  try {
    const result = await sendToTelegram(text, imageUrl);
    if (result.ok) { sentToday++; lastSent = new Date().toISOString(); }
    addLog(result.ok ? "ok" : "err", "Qo'lda: " + text.slice(0, 50));
    res.json(result);
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post("/api/settings", (req, res) => {
  const { kunuz, daryo, newsapi } = req.body;
  if (typeof kunuz === "boolean") settings.kunuz = kunuz;
  if (typeof daryo === "boolean") settings.daryo = daryo;
  if (typeof newsapi === "boolean") settings.newsapi = newsapi;
  addLog("info", `Sozlamalar saqlandi: kun.uz=${settings.kunuz} daryo=${settings.daryo} newsapi=${settings.newsapi}`);
  res.json({ ok: true, settings });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("ok", `Server: http://localhost:${PORT}`);
  addLog("info", `Kanal: ${CHANNEL_ID}`);
  addLog("info", `Jadval: ${AUTO_INTERVAL}`);
  addLog("info", `Digest: ${DIGEST_TIME}`);
  addLog("info", "Manbalar: Kun.uz + Daryo.uz + NewsAPI");
});
