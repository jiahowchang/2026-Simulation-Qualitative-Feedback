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

// 只允許這些來源呼叫（輕量防護；真正的花費上限請在 Anthropic Console 設定）
const ALLOWED_ORIGINS = [
  "https://jiahowchang.github.io",
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
