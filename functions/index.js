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
    const rate = Math.min(1.3, Math.max(0.7, parseFloat(body.rate) || 1.0));

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

    // ===== Google Cloud TTS（cmn-TW 台灣國語）=====
    const voice = /^cmn-TW-[A-Za-z0-9-]+$/.test(body.voice || "") ? body.voice : "cmn-TW-Wavenet-A";

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
          voice: { languageCode: "cmn-TW", name: voice },
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
