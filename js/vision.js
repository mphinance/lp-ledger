// vision.js — provider-agnostic BYOK vision accelerator (HYBRID OCR fork).
// The DEFAULT read path stays pure Tesseract (privacy literal). This is an
// OPT-IN accelerator offered only on flagged cells. It sends ONLY the cropped
// cell (never the full screenshot) to a user-chosen endpoint with the user's
// own key. Keys live in sessionStorage ONLY — never localStorage, never sent
// anywhere but the chosen endpoint.
//
// Adapter interface (one seam, many backends):
//   { id, label, defaultModel, family, stub?, custom?,
//     buildRequest(dataUrl, prompt, cfg) -> { url, headers, body },
//     parseResponse(json) -> text }
// cfg = { model, key, baseUrl } (the documented buildRequest carries ctx).

// Tight, deterministic prompt → parseResponse just needs to find a JSON object.
export const VISION_PROMPT =
  "You are reading ONE cell cropped from a brokerage positions/orders table. " +
  "Return ONLY a compact JSON object: {\"value\": <the cell content as a string, " +
  "keep commas/decimals/$/% exactly as shown, use the infinity symbol as the word " +
  "\"inf\", or null if blank/unreadable>, \"type\": \"money|percent|date|text|ticker\"}. " +
  "Do NOT guess. If you cannot read it confidently, set value to null. No prose, no markdown.";

const KEY_PREFIX = "ttv-key-"; // sessionStorage only

function trimSlash(s) { return String(s || "").replace(/\/+$/, ""); }

// One factory powers OpenRouter (default), OpenAI, and Custom/local (Ollama,
// LM Studio, vLLM, llama.cpp) — all speak the OpenAI vision message format.
function openaiCompat({ id, label, defaultModel, endpoint, custom = false }) {
  return {
    id, label, defaultModel, family: "openai", custom,
    buildRequest(dataUrl, prompt, cfg = {}) {
      const url = custom ? trimSlash(cfg.baseUrl) + "/chat/completions" : endpoint;
      const headers = { "Content-Type": "application/json" };
      if (cfg.key) headers["Authorization"] = "Bearer " + cfg.key; // local endpoints may need no key
      if (id === "openrouter") {
        // optional attribution headers (OpenRouter-friendly)
        try { headers["HTTP-Referer"] = location.origin; } catch (e) {}
        headers["X-Title"] = "tt-tracker";
      }
      const body = {
        model: cfg.model || defaultModel,
        temperature: 0,
        max_tokens: 120,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
      };
      return { url, headers, body };
    },
    parseResponse(json) {
      return (json && json.choices && json.choices[0] && json.choices[0].message
        && json.choices[0].message.content) || "";
    },
  };
}

// Anthropic / Claude native adapter.
// Sends ONLY the cropped cell. Key goes in x-api-key header, never persisted.
// The anthropic-dangerous-direct-browser-access header is required for browser
// direct calls per Anthropic's CORS policy.
function anthropicAdapter() {
  const id = "anthropic";
  const defaultModel = "claude-sonnet-4-6"; // current Claude vision model (use the bare id, no date suffix)
  return {
    id, label: "Anthropic / Claude", defaultModel, family: "anthropic",
    buildRequest(dataUrl, prompt, cfg = {}) {
      const model = cfg.model || defaultModel;
      const key = cfg.key || "";
      // Strip the data URI prefix — Anthropic wants raw base64 only.
      const b64 = String(dataUrl).replace(/^data:[^;]+;base64,/, "");
      const url = "https://api.anthropic.com/v1/messages";
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      };
      const body = {
        model,
        max_tokens: 120,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
            { type: "text", text: prompt },
          ],
        }],
      };
      return { url, headers, body };
    },
    parseResponse(json) {
      return (json && json.content && json.content[0] && json.content[0].text) || "";
    },
  };
}

// Google / Gemini native adapter.
// Model name goes in the URL path; API key goes in the ?key= query param.
// Only the cropped cell is sent; no key is written to localStorage.
function geminiAdapter() {
  const id = "gemini";
  const defaultModel = "gemini-2.5-flash"; // current Gemini flash vision model
  return {
    id, label: "Google / Gemini", defaultModel, family: "gemini",
    buildRequest(dataUrl, prompt, cfg = {}) {
      const model = cfg.model || defaultModel;
      const key = cfg.key || "";
      // Strip the data URI prefix — Gemini wants raw base64 only.
      const b64 = String(dataUrl).replace(/^data:[^;]+;base64,/, "");
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const headers = { "Content-Type": "application/json" };
      const body = {
        contents: [{
          parts: [
            { inline_data: { mime_type: "image/png", data: b64 } },
            { text: prompt },
          ],
        }],
      };
      return { url, headers, body };
    },
    parseResponse(json) {
      return (
        json &&
        json.candidates &&
        json.candidates[0] &&
        json.candidates[0].content &&
        json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] &&
        json.candidates[0].content.parts[0].text
      ) || "";
    },
  };
}

export const PROVIDERS = [
  openaiCompat({ id: "openrouter", label: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", defaultModel: "openai/gpt-4o-mini" }),
  openaiCompat({ id: "openai", label: "OpenAI / ChatGPT", endpoint: "https://api.openai.com/v1/chat/completions", defaultModel: "gpt-4o-mini" }),
  openaiCompat({ id: "custom", label: "Custom / local (Ollama · LM Studio · vLLM)", endpoint: "", defaultModel: "llama3.2-vision", custom: true }),
  anthropicAdapter(),
  geminiAdapter(),
];

export const DEFAULT_PROVIDER = "openrouter";

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

// --- key handling: sessionStorage ONLY ---
export function setKey(providerId, key) {
  try {
    if (key) sessionStorage.setItem(KEY_PREFIX + providerId, key);
    else sessionStorage.removeItem(KEY_PREFIX + providerId);
  } catch (e) { /* sessionStorage unavailable */ }
}
export function getKey(providerId) {
  try { return sessionStorage.getItem(KEY_PREFIX + providerId) || ""; } catch (e) { return ""; }
}
export function clearAllKeys() {
  try {
    for (const p of PROVIDERS) sessionStorage.removeItem(KEY_PREFIX + p.id);
  } catch (e) {}
}

// Parse the model's text into a deterministic {value, type}. Refuse to guess.
export function parseVisionText(text) {
  if (!text) return { value: null, type: null, raw: "" };
  const raw = String(text).trim();
  let obj = null;
  const m = raw.match(/\{[\s\S]*\}/); // first JSON object
  if (m) { try { obj = JSON.parse(m[0]); } catch (e) { obj = null; } }
  if (obj && Object.prototype.hasOwnProperty.call(obj, "value")) {
    let v = obj.value;
    if (v === null || v === undefined || v === "" || /^(null|n\/a|unreadable|unknown)$/i.test(String(v))) v = null;
    return { value: v === null ? null : String(v), type: obj.type || null, raw };
  }
  // No JSON → don't guess.
  return { value: null, type: null, raw };
}

// Send ONE crop to the chosen provider. cfg = {provider, model, baseUrl, key}.
// Returns { ok, value, type, engine, raw, error }.
export async function readCropWithVision(dataUrl, cfg) {
  const adapter = getProvider(cfg.provider);
  if (adapter.stub) return { ok: false, error: `${adapter.label} is a next-pass stub.`, engine: adapter.id };
  if (!dataUrl) return { ok: false, error: "no crop available for this cell", engine: adapter.id };
  let req;
  try { req = adapter.buildRequest(dataUrl, VISION_PROMPT, cfg); }
  catch (e) { return { ok: false, error: e.message, engine: adapter.id }; }
  const engine = `${adapter.id}:${cfg.model || adapter.defaultModel}`;
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 160); } catch (e) {}
      return { ok: false, error: `HTTP ${res.status} ${detail}`, engine };
    }
    const json = await res.json();
    const text = adapter.parseResponse(json);
    const parsed = parseVisionText(text);
    return { ok: true, value: parsed.value, type: parsed.type, raw: parsed.raw, engine };
  } catch (e) {
    return { ok: false, error: e.message || "network error", engine };
  }
}

// For tests / introspection: expose request construction without sending.
export function buildVisionRequest(dataUrl, cfg) {
  return getProvider(cfg.provider).buildRequest(dataUrl, VISION_PROMPT, cfg);
}
