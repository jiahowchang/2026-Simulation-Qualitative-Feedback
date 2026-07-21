"use strict";
/* ================================================================
   SimPatient AI 病人對話後端代理（Cloud Functions 2nd gen）
   - 把 Anthropic API Key 藏在伺服器端（Secret Manager），瀏覽器看不到
   - 學員端 simpatient.html POST 對話過來 → 用伺服器 Key 轉發給 Claude → 回傳
   - Key 設定：firebase functions:secrets:set ANTHROPIC_KEY
   ================================================================ */
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const ANTHROPIC_KEY = defineSecret("ANTHROPIC_KEY");
const ELEVEN_KEY = defineSecret("ELEVEN_KEY");   // ElevenLabs 聲音克隆（未設定時 tts 自動退回 Google）
const YATING_KEY = defineSecret("YATING_KEY");   // 雅婷 TTS（台語/國語聲優；未設定時自動退回 Google）

// 只允許這些來源呼叫（輕量防護；真正的花費上限請在 Anthropic Console 設定）
const ALLOWED_ORIGINS = [
  "https://jiahowchang.github.io",
  "https://jiahow-expense.web.app",
  "http://localhost:8080",
  "http://localhost:8081",
  "http://localhost:5000",
  "http://localhost:3000",
];
// 只允許這些模型，避免被改成更貴的設定
const ALLOWED_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

exports.patient = onRequest(
  {
    region: "us-central1",
    secrets: [ANTHROPIC_KEY],
    maxInstances: 10,          // 同時最多 10 個實例，避免暴衝
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (req, res) => {
    const origin = req.headers.origin || "";
    const originOk = ALLOWED_ORIGINS.includes(origin);
    if (originOk) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method not allowed" } }); return; }
    if (!originOk) { res.status(403).json({ error: { message: "Origin not allowed" } }); return; }

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length) {
      res.status(400).json({ error: { message: "messages required" } });
      return;
    }
    const model = ALLOWED_MODELS.includes(body.model) ? body.model : "claude-opus-4-8";
    const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 700, 1), 1500);
    const system = typeof body.system === "string" ? body.system : "";

    try {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY.value(),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
      });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(502).json({ error: { message: "proxy error: " + (e && e.message || e) } });
    }
  }
);

/* ================================================================
   台灣口音真人感語音 TTS 代理（Google Cloud Text-to-Speech, cmn-TW）
   - 用函式執行身分（metadata token）呼叫，不需另外管 API key
   - 需在 GCP 啟用 Text-to-Speech API：texttospeech.googleapis.com
   - POST { text, voice?, rate? } → { audio: base64 MP3 }
   ================================================================ */
exports.tts = onRequest(
  { region: "us-central1", maxInstances: 5, timeoutSeconds: 30, memory: "256MiB", secrets: [ELEVEN_KEY, YATING_KEY] },
  async (req, res) => {
    const origin = req.headers.origin || "";
    const originOk = ALLOWED_ORIGINS.includes(origin);
    if (originOk) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method not allowed" } }); return; }
    if (!originOk) { res.status(403).json({ error: { message: "Origin not allowed" } }); return; }

    const body = req.body || {};
    const text = String(body.text || "").slice(0, 600);
    if (!text.trim()) { res.status(400).json({ error: { message: "text required" } }); return; }
    const rate = Math.min(2.0, Math.max(0.25, parseFloat(body.rate) || 1.0));

    // ===== ElevenLabs 真人克隆聲：voice 形如 "eleven:<voiceId>"，且已設定 ELEVEN_KEY =====
    const evMatch = /^eleven:([A-Za-z0-9]{8,40})$/.exec(body.voice || "");
    const evKey = (() => { try { return ELEVEN_KEY.value(); } catch (e) { return ""; } })();
    if (evMatch && evKey && evKey.length > 20) {
      try {
        const r = await fetch(
          "https://api.elevenlabs.io/v1/text-to-speech/" + evMatch[1] + "?output_format=mp3_44100_64",
          { method: "POST",
            headers: { "xi-api-key": evKey, "content-type": "application/json" },
            body: JSON.stringify({ text, model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.45, similarity_boost: 0.8 } }) });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          res.json({ audio: buf.toString("base64"), mime: "audio/mpeg", provider: "eleven" });
          return;
        }
        // 失敗就往下走 Google 備援
      } catch (e) { /* 走 Google 備援 */ }
    }

    // ===== 雅婷 TTS：voice 形如 "yating:<model>"（台語 tai_female_1/tai_male_1/tai_female_2；
    //       國語 zh_en_female_1/zh_en_male_1/zh_en_female_2），且已設定 YATING_KEY =====
    const ytMatch = /^yating:([a-z0-9_]{3,30})$/i.exec(body.voice || "");
    const ytKey = (() => { try { return YATING_KEY.value(); } catch (e) { return ""; } })();
    if (ytMatch && ytKey && ytKey.length > 10) {
      try {
        // 雅婷字數上限 600 units（中文/全形=2、半形=1），保守截斷
        let units = 0, cut = "";
        for (const ch of text) { units += ch.charCodeAt(0) > 255 ? 2 : 1; if (units > 590) break; cut += ch; }
        // 雅婷 speed 語意與 Google 相反（越小越快、0.5~1.5）：把 rate 0.7~1.3 映射為 1.3~0.7
        const ytSpeed = Math.min(1.5, Math.max(0.5, 2 - rate));
        const r = await fetch("https://tts.api.yating.tw/v2/speeches/short", {
          method: "POST",
          headers: { key: ytKey, "content-type": "application/json" },
          body: JSON.stringify({
            input: { text: cut, type: "text" },
            voice: { model: ytMatch[1].toLowerCase(), speed: ytSpeed, pitch: 1.0, energy: 1.0 },
            audioConfig: { encoding: "LINEAR16", sampleRate: "16K" },   // MP3 官方標示「即將支援」，先用 WAV
          }),
        });
        if (r.ok || r.status === 201) {
          const d = await r.json();
          if (d && d.audioContent) {
            res.json({ audio: d.audioContent, mime: "audio/wav", provider: "yating" });
            return;
          }
        }
        // 失敗就往下走 Google 備援
      } catch (e) { /* 走 Google 備援 */ }
    }

    // ===== Google Cloud TTS：台灣國語 cmn-TW 與英文 en-US/en-GB/en-AU 神經語音 =====
    // voice 例：cmn-TW-Wavenet-A、en-US-Chirp3-HD-Aoede、en-US-Neural2-J、en-US-Studio-O
    const voice = /^(cmn-TW|en-US|en-GB|en-AU)-[A-Za-z0-9-]+$/.test(body.voice || "")
      ? body.voice : "cmn-TW-Wavenet-A";
    const languageCode = voice.split("-").slice(0, 2).join("-");

    try {
      const tokRes = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { headers: { "Metadata-Flavor": "Google" } }
      );
      const { access_token } = await tokRes.json();
      const upstream = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
        method: "POST",
        headers: { authorization: "Bearer " + access_token, "content-type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode, name: voice },
          audioConfig: { audioEncoding: "MP3", speakingRate: rate },
        }),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json({ audio: data.audioContent, mime: "audio/mpeg", provider: "google" });
    } catch (e) {
      res.status(502).json({ error: { message: "tts error: " + (e && e.message || e) } });
    }
  }
);

/* ================================================================
   雅婷即時語音辨識（ASR）一次性密碼代理
   - 國台語混講辨識 asr-zh-tw-std；API key 藏在伺服器端
   - 瀏覽器 POST {pipeline?} → 取得 60 秒有效的一次性 token
     → 直連 wss://asr.api.yating.tw/ws/v1/?token=... 串流 PCM
   ================================================================ */
exports.stt = onRequest(
  { region: "us-central1", maxInstances: 5, timeoutSeconds: 15, memory: "256MiB",
    secrets: [YATING_KEY], invoker: "public" },
  async (req, res) => {
    const origin = req.headers.origin || "";
    const originOk = ALLOWED_ORIGINS.includes(origin);
    if (originOk) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: { message: "Method not allowed" } }); return; }
    if (!originOk) { res.status(403).json({ error: { message: "Origin not allowed" } }); return; }

    const ytKey = (() => { try { return YATING_KEY.value(); } catch (e) { return ""; } })();
    if (!ytKey || ytKey.length < 10) { res.status(503).json({ error: { message: "YATING_KEY not set" } }); return; }

    const body = req.body || {};
    const pipeline = /^asr-[a-z-]{2,20}$/.test(body.pipeline || "") ? body.pipeline : "asr-zh-tw-std";
    try {
      const r = await fetch("https://asr.api.yating.tw/v1/token", {
        method: "POST",
        headers: { key: ytKey, "content-type": "application/json" },
        body: JSON.stringify({ pipeline }),
      });
      const d = await r.json();
      if (!(r.ok || r.status === 201) || !d.auth_token) {
        res.status(502).json({ error: { message: "yating token failed: " + JSON.stringify(d).slice(0, 200) } });
        return;
      }
      res.json({ token: d.auth_token });
    } catch (e) {
      res.status(502).json({ error: { message: "stt error: " + (e && e.message || e) } });
    }
  }
);

/* ================================================================
   每日英語學習（english.html）後端
   - 每天從 BBC（世界/科技/醫療/運動）與 Taipei Times（社會/台灣）RSS
     各取 1 篇 → 擷取內文 → Claude 產生逐句中英對照（台灣慣用語繁中）
     + 難字/慣用語解說與例句 → 存 Firestore eng_daily/{YYYY-MM-DD}
   - engdaily：HTTP 觸發（前端「生成今日內容」按鈕 / 補生成過去日期）
   - engdailyCron：每天 05:10（台北時間）自動生成，打開網頁即有內容
   - 每天輪流跳過 5 個分類中的 1 個 → 每天 4 篇
   ================================================================ */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
admin.initializeApp();

const ENG_SOURCES = [
  { cat: "world",   catZh: "世界時事", source: "BBC News",     rss: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { cat: "tech",    catZh: "科技",     source: "BBC News",     rss: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { cat: "health",  catZh: "醫療",     source: "BBC News",     rss: "https://feeds.bbci.co.uk/news/health/rss.xml" },
  { cat: "sport",   catZh: "運動",     source: "BBC Sport",    rss: "https://feeds.bbci.co.uk/sport/rss.xml" },
  { cat: "society", catZh: "社會",     source: "Taipei Times", rss: "https://www.taipeitimes.com/xml/index.rss" },
];

// 台北時間的今天（UTC+8）
function engTodayTW() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function engDecodeEnt(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function engFetchText(url) {
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!r.ok) throw new Error("fetch " + r.status + " " + url);
  return await r.text();
}

// RSS 2.0 與 RSS 1.0（RDF，Taipei Times）都支援
function engParseRss(xml) {
  return [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)].map(m => {
    const t = (m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
    const l = (m[1].match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1] || "";
    return { title: engDecodeEnt(t.trim()), link: engDecodeEnt(l.trim()) };
  }).filter(it => it.title && /^https?:\/\//.test(it.link));
}

// 只取 <article> 內的 <p>，避開導覽列/頁尾；殘餘雜訊由 Claude 再過濾一次
function engExtractParas(html) {
  const artM = html.match(/<article[\s\S]*?<\/article>/i);
  if (artM) html = artM[0];
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m =>
    engDecodeEnt(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
  return ps.filter(t =>
    t.length > 60 &&
    !/cookie|copyright|all rights reserved|follow bbc|subscribe|newsletter|to play this video/i.test(t)
  ).slice(0, 14);
}

/* ── TED 演講：最新片單 → 逐句字幕 → 影片嵌入 ── */
function engNextData(html) {
  const m = html.match(/id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// 最新演講的 slug 清單（TED 沒有可用的新片 RSS，改解析片單頁）
async function engTedSlugs() {
  const html = await engFetchText("https://www.ted.com/talks?sort=newest");
  return [...new Set([...html.matchAll(/\/talks\/([a-z0-9_]{12,90})/g)].map(m => m[1]))];
}

// 取單支演講的「有時間碼字幕」與影片資訊；沒有字幕（新片未上字幕、純音樂表演）回 null
async function engTedTalk(slug) {
  const d = engNextData(await engFetchText("https://www.ted.com/talks/" + slug + "/transcript"));
  const pp = d && d.props && d.props.pageProps;
  if (!pp) return null;
  const paras = ((pp.transcriptData || {}).translation || {}).paragraphs || [];
  const cues = [];
  for (const p of paras) for (const c of (p.cues || [])) {
    const t = String(c.text || "").replace(/\s+/g, " ").trim();
    if (t && typeof c.time === "number") cues.push({ text: t, time: c.time });
  }
  if (cues.length < 40) return null;                 // 字幕太少不拿來當教材
  const v = pp.videoData || {};
  let pd = v.playerData;
  if (typeof pd === "string") { try { pd = JSON.parse(pd); } catch (e) { pd = null; } }
  const ext = (pd && pd.external) || {};
  const youtube = /^[A-Za-z0-9_-]{8,20}$/.test(ext.code || "") && /youtube/i.test(ext.service || "")
    ? ext.code : "";
  return {
    slug, cues, youtube,
    title: v.title || "",
    presenter: v.presenterDisplayName || "",
    duration: v.duration || 0,
    url: v.canonicalUrl || ("https://www.ted.com/talks/" + slug),
    video: "https://embed.ted.com/talks/" + slug,     // 沒有 YouTube 時的備援播放器
  };
}

// YouTube 影片是否真的可嵌入（最新的 TED 演講常常還沒上架 YouTube → oEmbed 回 403）
async function engYoutubeEmbeddable(id) {
  try {
    const u = "https://www.youtube.com/oembed?format=json&url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + id);
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    return r.ok;
  } catch (e) { return false; }
}

// 依序試候選片，回傳第一支「有時間碼字幕 + YouTube 可嵌入」的
// （要能逐句同步高亮，就必須拿得到播放時間，所以 YouTube 可嵌入是硬條件）
async function engPickTed(prevUrls) {
  const slugs = await engTedSlugs();
  let tried = 0;
  for (const slug of slugs) {
    if (prevUrls.has("https://www.ted.com/talks/" + slug)) continue;
    if (++tried > 10) break;                         // 最多試 10 支，避免拖太久
    try {
      const t = await engTedTalk(slug);
      if (!t || prevUrls.has(t.url)) continue;
      if (!t.youtube || !(await engYoutubeEmbeddable(t.youtube))) continue;
      return t;
    } catch (e) { /* 換下一支 */ }
  }
  throw new Error("ted: 找不到「有字幕且 YouTube 可嵌入」的新演講");
}

/* 字幕 cue → 完整句子（含起始時間與句內時間斷點，供逐字高亮內插）
   cue 是字幕行，常把一句話切成好幾段，也可能一行含好幾句，所以要先接成全文再依句尾切。 */
const ENG_ABBR = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|Inc|Ltd|Co|U\.S|U\.K|a\.m|p\.m)\.$/i;
function engCuesToSentences(cues) {
  let text = "";
  const marks = [];                                   // [全文字元位移, 毫秒]
  for (const c of cues) {
    const t = String(c.text || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    marks.push([text.length, c.time]);
    text += t + " ";
  }
  text = text.trim();
  if (!text) return [];

  // 依句尾標點切句；縮寫（Mr. / U.S. / e.g.）不算句尾
  const spans = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!/[.!?]/.test(text[i])) continue;
    let j = i;
    while (j + 1 < text.length && /[.!?"'’”)\]]/.test(text[j + 1])) j++;   // 吃掉連續標點與引號
    const next = text[j + 1];
    if (next && next !== " ") continue;                                    // 例如 3.5、U.S.A 中間
    const piece = text.slice(start, j + 1);
    if (ENG_ABBR.test(piece.trim())) continue;                             // 是縮寫，不切
    spans.push([start, j + 1]);
    start = j + 2;
    i = j;
  }
  if (start < text.length) spans.push([start, text.length]);               // 最後一句可能沒句點

  const timeAt = idx => {
    let t = marks.length ? marks[0][1] : 0;
    for (const [ci, ms] of marks) { if (ci <= idx) t = ms; else break; }
    return t;
  };
  const out = [];
  for (const [s, e] of spans) {
    const raw = text.slice(s, e);
    const lead = raw.length - raw.trimStart().length;
    const en = raw.trim();
    if (en.length < 2) continue;
    const base = s + lead;                             // 句子第一個字元在全文中的位置
    const inner = marks.filter(([ci]) => ci >= base && ci < e).map(([ci, ms]) => [ci - base, ms]);
    const t0 = timeAt(base);
    if (!inner.length || inner[0][0] > 0) inner.unshift([0, t0]);
    // 時間必須遞增，避免內插算出負值
    for (let i = 1; i < inner.length; i++) if (inner[i][1] < inner[i - 1][1]) inner[i][1] = inner[i - 1][1];
    // Firestore 陣列不能直接巢狀陣列 → 存成 {c: 句內字元位移, t: 毫秒}
    out.push({ en, t: t0, marks: inner.map(([c, ms]) => ({ c, t: ms })) });
  }
  return out;
}

// 整份逐字稿翻成繁中：分批平行呼叫，維持與英文句子一一對應
async function engTranslateLines(apiKey, lines) {
  const CHUNK = 30;
  const chunks = [];
  for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK));
  const results = await Promise.all(chunks.map(async (chunk, ci) => {
    const numbered = chunk.map((s, i) => (i + 1) + ". " + s).join("\n");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: "你是英翻中譯者，翻成台灣人日常慣用的繁體中文（口語自然、不用中國大陸用語）。" +
          "只回傳一個 JSON 字串陣列，元素數量必須與輸入行數完全相同，不加任何說明。",
        messages: [{ role: "user", content:
          "把下列 " + chunk.length + " 行 TED 演講字幕逐行翻成繁體中文（保持一一對應，第 n 行對第 n 個元素）：\n\n" +
          numbered + "\n\n只回傳 JSON 陣列，例如 [\"第一行中文\",\"第二行中文\"]" }],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const d = await r.json();
    if (!r.ok) throw new Error("translate " + r.status);
    const text = (d.content || []).map(b => b.text || "").join("");
    const m = text.match(/\[[\s\S]*\]/);
    let arr = [];
    try { arr = m ? JSON.parse(m[0]) : []; } catch (e) { arr = []; }
    // 長度不符就補齊，確保索引不會錯位
    while (arr.length < chunk.length) arr.push("");
    return arr.slice(0, chunk.length);
  }));
  return results.flat();
}

async function engAskClaude(apiKey, title, paras, isTalk) {
  const sys =
    "你是為台灣成人學習者設計教材的英語教師。使用者母語是台灣慣用的繁體中文。" +
    "你只回傳一個嚴格合法的 JSON 物件，不加 markdown 圍欄、不加任何說明文字。";
  const prompt =
    (isTalk
      ? "以下是一場 TED 演講的標題與逐字稿片段（字幕斷行可能把句子切碎，請自行合併成完整句子）。\n\n"
      : "以下是一篇新聞的標題與段落（可能夾雜「Image source」「Published…」等網頁雜訊，請忽略雜訊）。\n\n") +
    "標題：" + title + "\n\n" + (isTalk ? "逐字稿：\n" : "段落：\n") + paras.join("\n") + "\n\n" +
    "請完成：\n" +
    "1. 從內文挑出 10~14 個「完整且連貫」的句子（保留原文用字，太長的句子可在不改變意思下輕微裁剪；依原文順序）。\n" +
    "2. 每句翻成台灣人日常慣用的繁體中文（口語自然、不要中國大陸用語，例如用「影片」不用「视频」、用「網路」不用「网络」）。\n" +
    "3. 標題也翻成繁體中文。\n" +
    "4. 從這些句子挑 5~8 個對台灣學習者困難的單字或片語，【優先挑由簡單單字組成的慣用語、片語動詞、搭配詞】（例如 pull off、come down to、on the fence）。每個提供：詞性、台灣慣用中文意思、白話解說（為什麼是這個意思／什麼情境用、易混淆處）、一個全新的例句（英文）與其繁中翻譯。\n" +
    "5. 估計文章 CEFR 難度（如 B1、B2、C1）。\n" +
    "6. 用一句繁中摘要全文。\n\n" +
    "回傳 JSON 格式：\n" +
    '{"title_en":"...","title_zh":"...","summary_zh":"...","level":"B2",' +
    '"sentences":[{"en":"...","zh":"..."}],' +
    '"vocab":[{"term":"...","pos":"...","zh":"...","note":"...","example_en":"...","example_zh":"..."}]}';
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4500,
      system: sys,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("claude " + r.status + ": " + JSON.stringify(d).slice(0, 200));
  const text = (d.content || []).map(b => b.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("claude 回應無 JSON");
  const out = JSON.parse(m[0]);
  if (!Array.isArray(out.sentences) || !out.sentences.length) throw new Error("claude 回應缺 sentences");
  return out;
}

async function engGenerateDaily(dateStr) {
  const db = admin.firestore();
  const ref = db.collection("eng_daily").doc(dateStr);

  // 用 create() 當鎖，避免排程與手動觸發同時生成
  try {
    await ref.create({ date: dateStr, status: "generating",
      createdAt: admin.firestore.FieldValue.serverTimestamp() });
  } catch (e) {
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : null;
    if (d && d.status === "ready") return d;
    const age = Date.now() - (d && d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0);
    if (d && d.status === "generating" && age < 10 * 60e3) return { date: dateStr, status: "generating" };
    // 上次生成卡住（>10 分鐘）→ 接手重生成
    await ref.set({ date: dateStr, status: "generating",
      createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  // 昨天用過的文章網址 → 避免重複
  const prevUrls = new Set();
  try {
    const y = new Date(new Date(dateStr + "T00:00:00Z").getTime() - 86400e3).toISOString().slice(0, 10);
    const prev = await db.collection("eng_daily").doc(y).get();
    if (prev.exists) (prev.data().articles || []).forEach(a => prevUrls.add(a.url));
  } catch (e) { /* 忽略 */ }

  // Taipei Times（社會/台灣）每天必有；BBC 四類每天輪流跳過一類；再加 1 支 TED 演講 → 每天 5 篇
  const dayNum = Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 86400e3);
  const bbc = ENG_SOURCES.filter(s => s.source !== "Taipei Times");
  const tt = ENG_SOURCES.filter(s => s.source === "Taipei Times");
  const skip = dayNum % bbc.length;
  const picked = bbc.filter((_, i) => i !== skip).concat(tt);

  const apiKey = ANTHROPIC_KEY.value();
  const newsJobs = picked.map(async src => {
    const items = engParseRss(await engFetchText(src.rss));
    const item = items.find(it => !prevUrls.has(it.link));
    if (!item) throw new Error(src.cat + ": RSS 無可用項目");
    const paras = engExtractParas(await engFetchText(item.link));
    if (paras.length < 3) throw new Error(src.cat + ": 內文擷取過少 " + item.link);
    const out = await engAskClaude(apiKey, item.title, paras);
    return { cat: src.cat, catZh: src.catZh, source: src.source, url: item.link, ...out };
  });

  // TED 演講（影片＋整份逐字稿逐句中英對照，附時間碼可跟著影片高亮）
  const tedJob = (async () => {
    const t = await engPickTed(prevUrls);
    const lines = engCuesToSentences(t.cues);
    if (lines.length < 10) throw new Error("ted: 逐字稿切句過少");

    // 單字/摘要/難度用開場片段即可；整份逐字稿另外全部翻譯
    let excerpt = "", i = 0;
    while (i < t.cues.length && excerpt.length < 7000) excerpt += t.cues[i++].text + " ";
    const [out, zhs] = await Promise.all([
      engAskClaude(apiKey, t.title, [excerpt.trim()], true),
      engTranslateLines(apiKey, lines.map(l => l.en)),
    ]);

    return {
      cat: "ted", catZh: "TED 演講", source: "TED", url: t.url,
      video: t.video, youtube: t.youtube, presenter: t.presenter, duration: t.duration,
      ...out,
      // 用「整份逐字稿」取代 Claude 挑的節錄，每句帶時間碼
      sentences: lines.map((l, i) => ({ en: l.en, zh: zhs[i] || "", t: l.t, marks: l.marks })),
    };
  })();

  const results = await Promise.allSettled(newsJobs.concat([tedJob]));

  const articles = results.filter(r => r.status === "fulfilled").map(r => r.value);
  const errors = results.filter(r => r.status === "rejected").map(r => String(r.reason && r.reason.message || r.reason).slice(0, 300));
  if (!articles.length) {
    await ref.delete();
    throw new Error("全部文章生成失敗: " + errors.join(" | "));
  }
  const doc = { date: dateStr, status: "ready",
    createdAt: admin.firestore.FieldValue.serverTimestamp(), articles, errors };
  await ref.set(doc);
  return doc;
}

exports.engdaily = onRequest(
  { region: "us-central1", secrets: [ANTHROPIC_KEY], maxInstances: 2,
    timeoutSeconds: 540, memory: "512MiB", invoker: "public" },
  async (req, res) => {
    const origin = req.headers.origin || "";
    const originOk = ALLOWED_ORIGINS.includes(origin);
    if (originOk) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (!originOk) { res.status(403).json({ error: { message: "Origin not allowed" } }); return; }

    const q = (req.method === "POST" ? (req.body || {}) : req.query) || {};
    let dateStr = typeof q.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : engTodayTW();
    if (dateStr > engTodayTW()) dateStr = engTodayTW();   // 不接受未來日期
    try {
      const doc = await engGenerateDaily(dateStr);
      res.json(doc);
    } catch (e) {
      res.status(500).json({ error: { message: String(e && e.message || e) } });
    }
  }
);

exports.engdailyCron = onSchedule(
  { region: "us-central1", schedule: "10 5 * * *", timeZone: "Asia/Taipei",
    secrets: [ANTHROPIC_KEY], timeoutSeconds: 540, memory: "512MiB", retryCount: 2 },
  async () => { await engGenerateDaily(engTodayTW()); }
);
