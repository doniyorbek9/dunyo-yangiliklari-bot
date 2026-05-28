const express = require("express");
const Jimp = require("jimp");
const path = require("path");
const fs = require("fs");
const _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// node-fetch v3 timeout wrapper (AbortController bilan)
async function fetch(url, options = {}) {
  const { timeout = 10000, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await _fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
const cron = require("node-cron");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GROQ_KEY = process.env.GROQ_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const CHANNEL_LINK = "https://t.me/global\\_xabar\\_uz";
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

function isGoodImageUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Sifatsiz rasmlarni filter qilish
  const badPatterns = [
    "maps.google", "maps.gstatic", "staticmap", "maps?",    // Google Maps
    "avatar", "profile", "icon", "logo", "favicon",          // Icon/logo
    "banner", "ads", "advert", "pixel", "track",             // Reklama
    "1x1", "placeholder", "blank", "spacer",                 // Bo'sh rasmlar
    ".gif",                                                    // GIF animatsiya
    "gravatar", "disqus",                                     // Foydalanuvchi avatarlari
  ];
  if (badPatterns.some(p => lower.includes(p))) return false;
  // Faqat rasm kengaytmalari
  const goodExt = [".jpg", ".jpeg", ".png", ".webp"];
  // URL kengaytmasi yo'q bo'lsa ham qabul qilish (ko'pchilik CDN URL)
  const hasExt = goodExt.some(e => lower.includes(e));
  const hasCDN = lower.includes("cdn") || lower.includes("image") || lower.includes("photo") || lower.includes("media") || lower.includes("upload") || lower.includes("news");
  return hasExt || hasCDN;
}

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
      const filteredImg = isGoodImageUrl(img) ? img : null;
      return {
        title, description: desc.replace(/<[^>]+>/g, "").trim().slice(0, 300),
        url: link, imageUrl: filteredImg, source: sourceName, lang
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
      model: "llama-3.3-70b-versatile",
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
4. 3-4 jumla, qisqa va qiziqarli — har jumla BOSHQACHA boshlansin, takrorlanmassin
5. Bir xil so'z bilan boshlanadigan jumlalar YOZMA
6. "O'zbekiston" so'zini faqat 1 marta ishlatish mumkin
7. 1-2 mos emoji qo'sh
8. Oxirida: "📎 Manba: ${news.source}"
9. Kategoriya: dunyo, sport, iqtisodiyot, siyosat, texnologiya, salomatlik

FAQAT JSON qaytar, boshqa hech narsa yozma:
{"text": "post matni", "category": "kategoriya"}`;

  const raw = await groqRequest(prompt, 700);
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("JSON topilmadi");
  const result = JSON.parse(jsonMatch[0]);
  result.text = cleanText(result.text);
  return result;
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

async function addWatermark(imageUrl) {
  try {
    const logoPath = path.join(__dirname, "public", "logo.png");
    if (!fs.existsSync(logoPath)) return null;

    // Download image
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    const [image, logo] = await Promise.all([
      Jimp.read(imgBuffer),
      Jimp.read(logoPath),
    ]);

    // Resize logo — pastki o'ng burchak uchun kichikroq
    const logoSize = Math.round(image.getWidth() * 0.22);
    logo.resize(logoSize, Jimp.AUTO);

    // Pastki o'ng burchakka joylashtirish
    const x = image.getWidth() - logo.getWidth() - 12;
    const y = image.getHeight() - logo.getHeight() - 12;

    image.composite(logo, x, y, {
      mode: Jimp.BLEND_SOURCE_OVER,
      opacitySource: 0.85,
      opacityDest: 1,
    });

    const resultBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
    return resultBuffer;
  } catch(e) {
    addLog("warn", "Watermark xato: " + e.message);
    return null;
  }
}

async function sendToTelegram(text, imageUrl) {
  if (imageUrl) {
    try {
      // Avval rasmni yuklab olishga harakat qilamiz
      const watermarked = await addWatermark(imageUrl);

      if (watermarked) {
        // FormData ishlatmasdan to'g'ri multipart qurish
        const boundary = "----TGBoundary" + Date.now().toString(36);
        const CRLF = "\r\n";

        const parts = [];
        const addField = (name, value) => {
          parts.push(
            `--${boundary}${CRLF}`,
            `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`,
            value, CRLF
          );
        };

        addField("chat_id", String(CHANNEL_ID));
        addField("caption", text);
        addField("parse_mode", "Markdown");

        const photoHeader = Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="photo"; filename="news.jpg"${CRLF}` +
          `Content-Type: image/jpeg${CRLF}${CRLF}`
        );
        const photoFooter = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);

        const textParts = Buffer.from(parts.join(""));
        const body = Buffer.concat([textParts, photoHeader, watermarked, photoFooter]);

        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
          timeout: 20000,
        });
        const d = await res.json();
        if (d.ok) {
          addLog("info", "Rasm watermark bilan yuborildi ✓");
          return d;
        }
        addLog("warn", "Watermark yuborishda Telegram xato: " + JSON.stringify(d));
      }
    } catch(e) {
      addLog("warn", "Watermark jarayonida xato: " + e.message);
    }

    // Fallback 1: rasmni buffer sifatida yuklab, watermarksiz yuborish
    try {
      const imgRes = await fetch(imageUrl, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TelegramBot)" }
      });
      if (imgRes.ok) {
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        const boundary = "----TGFallback" + Date.now().toString(36);
        const CRLF = "\r\n";
        const textPart = Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}${CHANNEL_ID}${CRLF}` +
          `--${boundary}${CRLF}Content-Disposition: form-data; name="caption"${CRLF}${CRLF}${text}${CRLF}` +
          `--${boundary}${CRLF}Content-Disposition: form-data; name="parse_mode"${CRLF}${CRLF}Markdown${CRLF}` +
          `--${boundary}${CRLF}Content-Disposition: form-data; name="photo"; filename="news.jpg"${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`
        );
        const footer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
        const body = Buffer.concat([textPart, imgBuffer, footer]);
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body,
          timeout: 20000,
        });
        const d = await res.json();
        if (d.ok) {
          addLog("info", "Rasm buffer bilan yuborildi ✓");
          return d;
        }
        addLog("warn", "Buffer yuborishda Telegram xato: " + JSON.stringify(d));
      }
    } catch(e) {
      addLog("warn", "Rasmni yuklashda xato: " + e.message);
    }

    // Fallback 2: URL to'g'ridan-to'g'ri Telegramga berish
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHANNEL_ID, photo: imageUrl, caption: text, parse_mode: "Markdown" }),
        timeout: 15000,
      });
      const d = await res.json();
      if (d.ok) {
        addLog("info", "Rasm URL bilan yuborildi ✓");
        return d;
      }
      addLog("warn", "URL yuborishda Telegram xato: " + JSON.stringify(d));
    } catch(e) {
      addLog("warn", "URL fallback xato: " + e.message);
    }

    // Fallback 3: rasmsiz matn yuborish
    addLog("warn", "Rasm yuklanmadi, rasmsiz yuborilmoqda...");
    return sendToTelegram(text, null);
  }

  // Rasmsiz yuborish
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL_ID, text, parse_mode: "Markdown" }),
    timeout: 15000,
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
      throw new Error(result.description || JSON.stringify(result));
    }
  } catch(e) {
    addLog("err", "Xato: " + e.message);
    return { ok: false, error: e.message };
  } finally { isRunning = false; }
}

async function runDigest() {
  if (isRunning) return { ok: false, error: "Band" };
  isRunning = true;
  try {
    addLog("info", "Digest tayyorlanmoqda...");
    const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long", year: "numeric" });

    let digestText;
    if (dailyNews.length === 0) {
      // Server restart bo'lsa yoki yangilik yo'q bo'lsa — umumiy digest
      addLog("warn", "dailyNews bo'sh, umumiy digest tayyorlanmoqda...");
      const prompt = `O'zbek Telegram kanali uchun bugungi kun yakuniy digest yoz (${today}).
Dunyo, O'zbekiston, iqtisodiyot, sport, texnologiya mavzularini qamrab ol.
Format:
- Sarlavha: "📰 *Bugun nimalar bo'ldi? — ${today}*"
- 6-8 ta dolzarb mavzu, har biri 1-2 jumlada
- O'zbek tilida, emoji bilan
- Oxirida: #digest #bugunyangiliklari
Faqat tayyor post matnini yoz.`;
      digestText = await groqRequest(prompt, 1200);
    } else {
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
      digestText = await groqRequest(prompt, 1500);
    }

    const fullText = digestText + AD_TEXT;
    const result = await sendToTelegram(fullText, null);
    if (result.ok) {
      addLog("ok", "Digest yuborildi!");
      return { ok: true, text: fullText };
    } else throw new Error(result.description || JSON.stringify(result));
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
    isRunning = false; // Eski stuck flag ni tozalash
    addLog("ok", "Bot ishga tushdi");
  }
  res.json({ ok: true, botPaused, startFromTomorrow });
});

async function searchTopic(query) {
  const prompt = `Sen Telegram kanal muharririsan. O'zbek tilida "${query}" mavzusida qisqa, jozibali post yoz.
MUHIM QOIDALAR:
1. FAQAT o'zbek tilida yoz
2. Sarlavhani *yulduzcha* ichida yoz: *🔍 Sarlavha*
3. 3-4 jumla, qisqa va qiziqarli
4. 1-2 mos emoji qo'sh
5. Kategoriya: dunyo, sport, iqtisodiyot, siyosat, texnologiya, salomatlik

FAQAT JSON qaytar:
{"text": "post matni", "category": "kategoriya"}`;
  const raw = await groqRequest(prompt, 700);
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error("JSON topilmadi");
  const result = JSON.parse(jsonMatch[0]);
  result.text = cleanText(result.text);
  return result;
}

app.post("/api/search", authMiddleware, async (req, res) => {
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

// ============ OB-HAVO VA DOLLAR KURSI ============

const morningSettings = {
  weatherHour: 6,
  rateHour: 6,
  weatherText: null, // tahrirlangan matn
  rateText: null,    // tahrirlangan matn
};

let weatherCronJob = null;
let rateCronJob = null;

function startMorningCrons() {
  if (weatherCronJob) weatherCronJob.stop();
  if (rateCronJob) rateCronJob.stop();

  weatherCronJob = cron.schedule(`0 ${morningSettings.weatherHour} * * *`, () => {
    addLog("info", `Ob-havo yuborilmoqda (${morningSettings.weatherHour}:00)...`);
    runWeather();
  });

  rateCronJob = cron.schedule(`0 ${morningSettings.rateHour} * * *`, () => {
    addLog("info", `Dollar kursi yuborilmoqda (${morningSettings.rateHour}:00)...`);
    runRate();
  });

  addLog("info", `Ob-havo: ${morningSettings.weatherHour}:00 | Kurs: ${morningSettings.rateHour}:00`);
}

async function fetchWeather() {
  try {
    const res = await fetch("https://wttr.in/Tashkent?format=j1", { timeout: 8000 });
    const data = await res.json();
    const cur = data.current_condition[0];
    const temp = cur.temp_C;
    const feels = cur.FeelsLikeC;
    const desc = cur.lang_uz?.[0]?.value || cur.weatherDesc[0].value;
    const humidity = cur.humidity;
    const wind = cur.windspeedKmph;
    const tomorrow = data.weather[1];
    const maxT = tomorrow.maxtempC;
    const minT = tomorrow.mintempC;

    return { temp, feels, desc, humidity, wind, maxT, minT };
  } catch(e) {
    addLog("warn", "Ob-havo xato: " + e.message);
    return null;
  }
}

async function fetchRates() {
  try {
    const res = await fetch("https://cbu.uz/uz/arkhiv-kursov-valyut/json/", { timeout: 8000 });
    const data = await res.json();
    const find = (code) => data.find(r => r.Ccy === code);
    const usd = find("USD");
    const eur = find("EUR");
    const rub = find("RUB");
    return { usd: usd?.Rate, eur: eur?.Rate, rub: rub?.Rate };
  } catch(e) {
    addLog("warn", "Kurs xato: " + e.message);
    return null;
  }
}

function getWeatherEmoji(temp) {
  if (temp >= 35) return "🥵";
  if (temp >= 25) return "☀️";
  if (temp >= 15) return "⛅";
  if (temp >= 5) return "🌥️";
  return "❄️";
}

async function buildWeatherText(custom = null) {
  if (custom) return custom + AD_TEXT;
  const w = await fetchWeather();
  if (!w) throw new Error("Ob-havo ma'lumoti olinmadi");
  const emoji = getWeatherEmoji(Number(w.temp));
  const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long" });
  return `${emoji} *Bugungi ob-havo — Toshkent | ${today}*

🌡 Harorat: *${w.temp}°C* (his qilish: ${w.feels}°C)
🌤 Holat: ${w.desc}
💧 Namlik: ${w.humidity}%
💨 Shamol: ${w.wind} km/soat

📅 *Ertaga:* ${w.minT}°C — ${w.maxT}°C

Kiyinishda ehtiyot bo'ling! ${emoji}
${AD_TEXT}`;
}

async function buildRateText(custom = null) {
  if (custom) return custom + AD_TEXT;
  const r = await fetchRates();
  if (!r) throw new Error("Kurs ma'lumoti olinmadi");
  const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long" });
  const usd = Number(r.usd).toLocaleString("uz-UZ");
  const eur = Number(r.eur).toLocaleString("uz-UZ");
  const rub = (Number(r.rub) * 100).toFixed(0);
  return `💵 *Valyuta kurslari — ${today}*
_(O'zbekiston Markaziy banki)_

🇺🇸 1 USD = *${usd}* so'm
🇪🇺 1 EUR = *${eur}* so'm
🇷🇺 100 RUB = *${rub}* so'm

📊 Kurslar har kuni yangilanadi
${AD_TEXT}`;
}


async function runMorningCombined(customWeather = null, customRate = null) {
  try {
    addLog("info", "Ertalab ob-havo va kurs birgalikda yuborilmoqda...");
    const [weatherText, rateText] = await Promise.all([
      buildWeatherText(customWeather || morningSettings.weatherText),
      buildRateText(customRate || morningSettings.rateText),
    ]);
    // Bitta xabarda birlashtirish
    const today = new Date().toLocaleDateString("uz-UZ", { day: "numeric", month: "long" });
    const combined = `🌅 *Xayrli tong! — ${today}*

` + weatherText.replace(/📢.*$/s, '').trim() + '

' + '─'.repeat(25) + '

' + rateText.replace(/📢.*$/s, '').trim() + AD_TEXT;
    const result = await sendToTelegram(combined, null);
    if (result.ok) {
      addLog("ok", "Ertalab xabar birgalikda yuborildi ✓");
      morningSettings.weatherText = null;
      morningSettings.rateText = null;
      return { ok: true, text: combined };
    } else throw new Error(result.description);
  } catch(e) {
    addLog("err", "Ertalab xabar: " + e.message);
    return { ok: false, error: e.message };
  }
}

async function runWeather(customText = null) {
  try {
    const text = await buildWeatherText(customText || morningSettings.weatherText);
    const result = await sendToTelegram(text, null);
    if (result.ok) {
      addLog("ok", "Ob-havo yuborildi ✓");
      morningSettings.weatherText = null;
      return { ok: true, text };
    } else throw new Error(result.description);
  } catch(e) {
    addLog("err", "Ob-havo: " + e.message);
    return { ok: false, error: e.message };
  }
}

async function runRate(customText = null) {
  try {
    const text = await buildRateText(customText || morningSettings.rateText);
    const result = await sendToTelegram(text, null);
    if (result.ok) {
      addLog("ok", "Kurs yuborildi ✓");
      morningSettings.rateText = null;
      return { ok: true, text };
    } else throw new Error(result.description);
  } catch(e) {
    addLog("err", "Kurs: " + e.message);
    return { ok: false, error: e.message };
  }
}

// Morning routes
app.get("/api/morning-status", authMiddleware, async (req, res) => {
  try {
    const [weather, rate] = await Promise.all([fetchWeather(), fetchRates()]);
    const weatherPreview = await buildWeatherText();
    const ratePreview = await buildRateText();
    res.json({ ok: true, weather, rate, weatherPreview, ratePreview, morningSettings });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/send-morning", authMiddleware, async (req, res) => {
  res.json(await runMorningCombined());
});

app.post("/api/send-weather", authMiddleware, async (req, res) => {
  const { customText } = req.body;
  res.json(await runWeather(customText || null));
});

app.post("/api/send-rate", authMiddleware, async (req, res) => {
  const { customText } = req.body;
  res.json(await runRate(customText || null));
});

app.post("/api/morning-settings", authMiddleware, (req, res) => {
  const { weatherHour, rateHour, weatherText, rateText } = req.body;
  if (weatherHour >= 4 && weatherHour <= 12) morningSettings.weatherHour = Number(weatherHour);
  if (rateHour >= 4 && rateHour <= 12) morningSettings.rateHour = Number(rateHour);
  if (typeof weatherText === "string") morningSettings.weatherText = weatherText || null;
  if (typeof rateText === "string") morningSettings.rateText = rateText || null;
  startMorningCrons();
  addLog("info", `Ertalab sozlandi: ob-havo ${morningSettings.weatherHour}:00, kurs ${morningSettings.rateHour}:00`);
  res.json({ ok: true, morningSettings });
});

// Start morning crons
startMorningCrons();