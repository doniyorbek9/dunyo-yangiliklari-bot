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

let sentToday = 0;
let lastSent = null;
let isRunning = false;
const logs = [];
const sentTitles = new Set(); // Yuborilgan yangiliklar

function addLog(type, msg) {
  const time = new Date().toLocaleTimeString("uz-UZ");
  logs.unshift({ type, msg, time });
  if (logs.length > 100) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// Kategoriyaga qarab heshteg
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

// NewsAPI dan yangilik
async function fetchNewsAPI() {
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
      source: a.source?.name || "Xorijiy manba",
    }));
}

// Kun.uz RSS dan yangilik
async function fetchKunUz() {
  try {
    const res = await fetch("https://kun.uz/rss", { timeout: 8000 });
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return items.slice(0, 10).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || "";
      const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
      const img = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] || null;
      return { title, description: desc.replace(/<[^>]+>/g, "").slice(0, 200), url: link, imageUrl: img, source: "Kun.uz" };
    }).filter(a => a.title && !sentTitles.has(a.title));
  } catch(e) {
    addLog("warn", "Kun.uz dan olib bo'lmadi: " + e.message);
    return [];
  }
}

// Daryo.uz RSS dan yangilik
async function fetchDaryoUz() {
  try {
    const res = await fetch("https://daryo.uz/feed", { timeout: 8000 });
    const xml = await res.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
    return items.slice(0, 10).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || "";
      const desc = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
      const img = item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] ||
                  item.match(/<media:content[^>]+url="([^"]+)"/)?.[1] || null;
      return { title, description: desc.replace(/<[^>]+>/g, "").slice(0, 200), url: link, imageUrl: img, source: "Daryo.uz" };
    }).filter(a => a.title && !sentTitles.has(a.title));
  } catch(e) {
    addLog("warn", "Daryo.uz dan olib bo'lmadi: " + e.message);
    return [];
  }
}

// Barcha manbalardan yangilik olish
async function fetchAllNews() {
  const [newsApi, kun, daryo] = await Promise.all([
    fetchNewsAPI(),
    fetchKunUz(),
    fetchDaryoUz(),
  ]);

  const all = [...kun, ...daryo, ...newsApi];
  if (all.length === 0) throw new Error("Hech qaysi manbadan yangilik topilmadi");

  // Tasodifiy tanlash (kun.uz va daryo.uz ga ustunlik)
  const priority = [...kun, ...daryo];
  const pool = priority.length > 0 ? priority : newsApi;
  return pool[Math.floor(Math.random() * Math.min(5, pool.length))];
}

// Groq AI tarjima
async function translateWithGroq(news) {
  const isUzbek = news.source === "Kun.uz" || news.source === "Daryo.uz";

  const prompt = isUzbek
    ? `Quyidagi o'zbek tilidagi yangilikni Telegram post qilib chiqar.

Sarlavha: ${news.title}
Tavsif: ${news.description}
Manba: ${news.source}

Qoidalar:
- O'zbek tilida yoz
- 3-4 jumla, qisqa va tushunarli
- Sarlavhani bold: *Sarlavha*
- 1-2 mos emoji qo'sh
- Kategoriyani aniqlash: dunyo, sport, iqtisodiyot, siyosat, texnologiya, salomatlik
- Faqat JSON qaytar, hech narsa qo'shma

{"text": "post matni", "category": "kategoriya"}`
    : `Quyidagi inglizcha yangilikni o'zbek tiliga tarjima qil va Telegram post tayyorla.

Sarlavha: ${news.title}
Tavsif: ${news.description}
Manba: ${news.source}

Qoidalar:
- Faqat o'zbek tilida yoz
- 3-4 jumla, qisqa va tushunarli
- Sarlavhani bold: *Sarlavha*
- 1-2 mos emoji qo'sh
- Kategoriyani aniqlash: dunyo, sport, iqtisodiyot, siyosat, texnologiya, salomatlik
- Faqat JSON qaytar, hech narsa qo'shma

{"text": "post matni", "category": "kategoriya"}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error("Groq javob bermadi: " + JSON.stringify(data));
  const raw = data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// Telegramga yuborish
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
  } else {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHANNEL_ID, text, parse_mode: "Markdown" }),
    });
    return res.json();
  }
}

// Asosiy jarayon
async function runCycle() {
  if (isRunning) return { ok: false, error: "Jarayon band, kuting..." };
  isRunning = true;
  try {
    addLog("info", "Yangilik qidirilmoqda...");
    const news = await fetchAllNews();
    addLog("info", `[${news.source}] ${news.title.slice(0, 60)}`);
    addLog("info", "Groq tarjima qilmoqda...");
    const translated = await translateWithGroq(news);
    const hashtags = getHashtags(translated.category);
    const finalText = translated.text + "\n\n" + hashtags;
    addLog("info", "Telegramga yuborilmoqda...");
    const result = await sendToTelegram(finalText, news.imageUrl);
    if (result.ok) {
      sentTitles.add(news.title);
      if (sentTitles.size > 500) {
        const first = sentTitles.values().next().value;
        sentTitles.delete(first);
      }
      sentToday++;
      lastSent = new Date().toISOString();
      addLog("ok", `[${news.source}] Yuborildi: ${translated.text.slice(0, 50)}...`);
      return { ok: true, text: finalText, category: translated.category, source: news.source };
    } else {
      throw new Error(result.description);
    }
  } catch (e) {
    addLog("err", "Xato: " + e.message);
    return { ok: false, error: e.message };
  } finally {
    isRunning = false;
  }
}

cron.schedule(AUTO_INTERVAL, () => {
  addLog("info", "Avtomatik yuborish...");
  runCycle();
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
    sentCount: sentTitles.size,
    logs: logs.slice(0, 20),
  });
});

app.post("/api/send-now", async (req, res) => {
  const result = await runCycle();
  res.json(result);
});

app.post("/api/send-custom", async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text) return res.json({ ok: false, error: "Matn kerak" });
  try {
    const result = await sendToTelegram(text, imageUrl);
    if (result.ok) { sentToday++; lastSent = new Date().toISOString(); }
    addLog(result.ok ? "ok" : "err", "Qo'lda yuborildi: " + text.slice(0, 50));
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog("ok", `Server ishga tushdi: http://localhost:${PORT}`);
  addLog("info", `Kanal: ${CHANNEL_ID}`);
  addLog("info", `Jadval: ${AUTO_INTERVAL}`);
  addLog("info", "Manbalar: NewsAPI + Kun.uz + Daryo.uz");
});