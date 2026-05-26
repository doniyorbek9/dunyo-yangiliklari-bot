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

function addLog(type, msg) {
  const time = new Date().toLocaleTimeString("uz-UZ");
  logs.unshift({ type, msg, time });
  if (logs.length > 100) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

async function fetchNews() {
  const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=10&apiKey=${NEWS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.articles || data.articles.length === 0) throw new Error("Yangilik topilmadi");
  const articles = data.articles.filter(a => a.title && a.description);
  const a = articles[Math.floor(Math.random() * Math.min(5, articles.length))];
  return {
    title: a.title,
    description: a.description || "",
    url: a.url,
    imageUrl: a.urlToImage || null,
    source: a.source?.name || "Xorijiy manba",
  };
}

async function translateWithGroq(news) {
  const prompt = `Quyidagi yangilikni o'zbek tiliga tarjima qil va Telegram post tayyorla.

Sarlavha: ${news.title}
Tavsif: ${news.description}
Manba: ${news.source}

Qoidalar:
- Faqat o'zbek tilida
- 3-4 jumla, qisqa
- Sarlavhani bold: *Sarlavha*
- 1-2 emoji qo'sh
- Oxirida: "📎 Manba: ${news.source}"
- Faqat JSON qaytar

{"text": "post matni", "category": "dunyo"}`;

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
      max_tokens: 500,
    }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error("Groq javob bermadi: " + JSON.stringify(data));
  const raw = data.choices[0].message.content.replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
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
  } else {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHANNEL_ID, text, parse_mode: "Markdown" }),
    });
    return res.json();
  }
}

async function runCycle() {
  if (isRunning) return { ok: false, error: "Jarayon band, kuting..." };
  isRunning = true;
  try {
    addLog("info", "Yangilik qidirilmoqda...");
    const news = await fetchNews();
    addLog("info", "Topildi: " + news.title.slice(0, 60));
    addLog("info", "Groq tarjima qilmoqda...");
    const translated = await translateWithGroq(news);
    addLog("info", "Telegramga yuborilmoqda...");
    const result = await sendToTelegram(translated.text, news.imageUrl);
    if (result.ok) {
      sentToday++;
      lastSent = new Date().toISOString();
      addLog("ok", "Yuborildi: " + translated.text.slice(0, 60) + "...");
      return { ok: true, text: translated.text, category: translated.category };
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
});