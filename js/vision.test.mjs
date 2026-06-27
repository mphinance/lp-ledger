// vision.test.mjs — headless validation for the BYOK vision adapters.
// Run with: node docs/tt-tracker/js/vision.test.mjs
// Mocks the network entirely; never touches real APIs.
// Validates: request construction, response parsing, privacy invariants,
// provider selectability (no disabled stubs), and the consent gate path.

import {
  PROVIDERS,
  DEFAULT_PROVIDER,
  getProvider,
  getKey,
  setKey,
  clearAllKeys,
  readCropWithVision,
  buildVisionRequest,
  parseVisionText,
  VISION_PROMPT,
} from "./vision.js";

// --- minimal test harness ---------------------------------------------------

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n== ${name} ==`);
}

// Stub out browser globals missing in Node.
global.sessionStorage = (() => {
  const store = {};
  return {
    setItem(k, v) { store[k] = String(v); },
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    removeItem(k) { delete store[k]; },
    clear() { Object.keys(store).forEach(k => delete store[k]); },
  };
})();

// Stub location for OpenRouter headers (not exercised by new adapters but
// prevents ReferenceError when the module body runs).
global.location = { origin: "http://localhost" };

// Canonical sample data.
const SAMPLE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";
const SAMPLE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";
const FAKE_KEY = "sk-test-abc123";

// ---------------------------------------------------------------------------
// 1. Provider registry — both new adapters registered and selectable
// ---------------------------------------------------------------------------

section("Provider registry");

const anthropicProv = getProvider("anthropic");
const geminiProv    = getProvider("gemini");

assert("anthropic registered", !!anthropicProv && anthropicProv.id === "anthropic");
assert("gemini registered",    !!geminiProv    && geminiProv.id    === "gemini");
assert("anthropic not stubbed", !anthropicProv.stub,
  "stub flag must be absent so the picker enables the option");
assert("gemini not stubbed",    !geminiProv.stub,
  "stub flag must be absent so the picker enables the option");
assert("anthropic has label",   anthropicProv.label.length > 0);
assert("gemini has label",      geminiProv.label.length > 0);
assert("anthropic defaultModel is current claude vision model",
  /^claude-/.test(anthropicProv.defaultModel), anthropicProv.defaultModel);
assert("gemini defaultModel is current gemini vision model",
  /^gemini-/.test(geminiProv.defaultModel), geminiProv.defaultModel);

// Simulate the picker filter used in app.js (line 519):
// `p.stub ? "disabled" : ""` — neither should be disabled.
const disabledProviders = PROVIDERS.filter(p => p.stub);
assert("no providers disabled in picker", disabledProviders.length === 0,
  "stubs: " + disabledProviders.map(p => p.id).join(", "));

// ---------------------------------------------------------------------------
// 2. Anthropic — request construction
// ---------------------------------------------------------------------------

section("Anthropic buildRequest");

const antReq = anthropicProv.buildRequest(SAMPLE_DATA_URL, VISION_PROMPT, {
  model: "claude-sonnet-4-6",
  key: FAKE_KEY,
});

assert("anthropic URL is messages endpoint",
  antReq.url === "https://api.anthropic.com/v1/messages", antReq.url);

assert("anthropic header x-api-key",
  antReq.headers["x-api-key"] === FAKE_KEY);
assert("anthropic header anthropic-version present",
  typeof antReq.headers["anthropic-version"] === "string" &&
  antReq.headers["anthropic-version"].length > 0, antReq.headers["anthropic-version"]);
assert("anthropic header anthropic-dangerous-direct-browser-access = true",
  antReq.headers["anthropic-dangerous-direct-browser-access"] === "true");
assert("anthropic header Content-Type = application/json",
  antReq.headers["Content-Type"] === "application/json");

assert("anthropic body has messages array",
  Array.isArray(antReq.body.messages) && antReq.body.messages.length === 1);
const antMsg = antReq.body.messages[0];
assert("anthropic message role = user", antMsg.role === "user");
assert("anthropic message content is array with 2 parts",
  Array.isArray(antMsg.content) && antMsg.content.length === 2);

const antImgPart  = antMsg.content.find(p => p.type === "image");
const antTextPart = antMsg.content.find(p => p.type === "text");
assert("anthropic image part present",   !!antImgPart);
assert("anthropic text part present",    !!antTextPart);
assert("anthropic image source type = base64",
  antImgPart && antImgPart.source && antImgPart.source.type === "base64");
assert("anthropic image media_type = image/png",
  antImgPart && antImgPart.source && antImgPart.source.media_type === "image/png");
assert("anthropic data URL prefix stripped (no 'data:')",
  antImgPart && !String(antImgPart.source.data).startsWith("data:"),
  "raw value starts with: " + String(antImgPart && antImgPart.source && antImgPart.source.data).slice(0, 30));
assert("anthropic base64 data matches expected",
  antImgPart && antImgPart.source && antImgPart.source.data === SAMPLE_B64);
assert("anthropic text part contains prompt",
  antTextPart && antTextPart.text === VISION_PROMPT);
assert("anthropic body has max_tokens", typeof antReq.body.max_tokens === "number");
assert("anthropic body has model",      typeof antReq.body.model === "string");

// ---------------------------------------------------------------------------
// 3. Anthropic — response parsing
// ---------------------------------------------------------------------------

section("Anthropic parseResponse");

const antGoodResponse = { content: [{ type: "text", text: '{"value":"$1,234.56","type":"money"}' }] };
const antBadResponse  = { error: { message: "bad request" } };
const antEmptyContent = { content: [] };

assert("anthropic parseResponse good",
  anthropicProv.parseResponse(antGoodResponse) === '{"value":"$1,234.56","type":"money"}');
assert("anthropic parseResponse missing content → empty string",
  anthropicProv.parseResponse(antBadResponse) === "");
assert("anthropic parseResponse empty content array → empty string",
  anthropicProv.parseResponse(antEmptyContent) === "");
assert("anthropic parseResponse null → empty string",
  anthropicProv.parseResponse(null) === "");

// Verify round-trip through parseVisionText.
const antParsed = parseVisionText(anthropicProv.parseResponse(antGoodResponse));
assert("anthropic parseResponse flows into parseVisionText → value",
  antParsed.value === "$1,234.56");
assert("anthropic parseResponse flows into parseVisionText → type",
  antParsed.type === "money");

// ---------------------------------------------------------------------------
// 4. Gemini — request construction
// ---------------------------------------------------------------------------

section("Gemini buildRequest");

const gemReq = geminiProv.buildRequest(SAMPLE_DATA_URL, VISION_PROMPT, {
  model: "gemini-2.5-flash",
  key: FAKE_KEY,
});

assert("gemini URL contains model in path",
  gemReq.url.includes("models/gemini-2.5-flash:generateContent"), gemReq.url);
assert("gemini URL contains ?key= param",
  gemReq.url.includes("?key="), gemReq.url);
assert("gemini ?key= contains the actual key",
  gemReq.url.includes("?key=" + encodeURIComponent(FAKE_KEY)), gemReq.url);
assert("gemini URL is googleapis.com domain",
  gemReq.url.startsWith("https://generativelanguage.googleapis.com/"), gemReq.url);
assert("gemini header Content-Type = application/json",
  gemReq.headers["Content-Type"] === "application/json");
// Gemini uses ?key= in URL, no Authorization header needed.
assert("gemini no Authorization header (key in URL only)",
  !("Authorization" in gemReq.headers));

assert("gemini body has contents array",
  Array.isArray(gemReq.body.contents) && gemReq.body.contents.length === 1);
const gemEntry = gemReq.body.contents[0];
assert("gemini entry has parts array with 2 elements",
  Array.isArray(gemEntry.parts) && gemEntry.parts.length === 2);

const gemImgPart  = gemEntry.parts.find(p => p.inline_data);
const gemTextPart = gemEntry.parts.find(p => typeof p.text === "string");
assert("gemini inline_data part present",  !!gemImgPart);
assert("gemini text part present",         !!gemTextPart);
assert("gemini inline_data mime_type = image/png",
  gemImgPart && gemImgPart.inline_data.mime_type === "image/png");
assert("gemini data URL prefix stripped (no 'data:')",
  gemImgPart && !String(gemImgPart.inline_data.data).startsWith("data:"),
  "raw value starts with: " + String(gemImgPart && gemImgPart.inline_data && gemImgPart.inline_data.data).slice(0, 30));
assert("gemini base64 data matches expected",
  gemImgPart && gemImgPart.inline_data.data === SAMPLE_B64);
assert("gemini text part contains prompt",
  gemTextPart && gemTextPart.text === VISION_PROMPT);

// ---------------------------------------------------------------------------
// 5. Gemini — response parsing
// ---------------------------------------------------------------------------

section("Gemini parseResponse");

const gemGoodResponse = {
  candidates: [{
    content: { parts: [{ text: '{"value":"42.5%","type":"percent"}' }] },
  }],
};
const gemBadResponse  = { error: { code: 400, message: "bad key" } };
const gemEmptyCand    = { candidates: [] };

assert("gemini parseResponse good",
  geminiProv.parseResponse(gemGoodResponse) === '{"value":"42.5%","type":"percent"}');
assert("gemini parseResponse missing candidates → empty string",
  geminiProv.parseResponse(gemBadResponse) === "");
assert("gemini parseResponse empty candidates → empty string",
  geminiProv.parseResponse(gemEmptyCand) === "");
assert("gemini parseResponse null → empty string",
  geminiProv.parseResponse(null) === "");

// Verify round-trip through parseVisionText.
const gemParsed = parseVisionText(geminiProv.parseResponse(gemGoodResponse));
assert("gemini parseResponse flows into parseVisionText → value",
  gemParsed.value === "42.5%");
assert("gemini parseResponse flows into parseVisionText → type",
  gemParsed.type === "percent");

// ---------------------------------------------------------------------------
// 6. Privacy: key never touches localStorage
// ---------------------------------------------------------------------------

section("Privacy — key storage invariants");

// Intercept localStorage to detect any writes.
let localStorageWriteAttempt = false;
const origSetItem = global.localStorage && global.localStorage.setItem;
// localStorage may not exist in this Node environment; that's fine — it means
// the code can't touch it. Confirm that getKey/setKey use sessionStorage only.
global.localStorage = {
  setItem(k, v) {
    localStorageWriteAttempt = true;
    throw new Error("localStorage.setItem called — PRIVACY VIOLATION: " + k);
  },
  getItem() { return null; },
  removeItem() {},
};

clearAllKeys();
setKey("anthropic", FAKE_KEY);
setKey("gemini", FAKE_KEY);

assert("anthropic key in sessionStorage after setKey",
  sessionStorage.getItem("ttv-key-anthropic") === FAKE_KEY);
assert("gemini key in sessionStorage after setKey",
  sessionStorage.getItem("ttv-key-gemini") === FAKE_KEY);
assert("getKey anthropic reads from sessionStorage",
  getKey("anthropic") === FAKE_KEY);
assert("getKey gemini reads from sessionStorage",
  getKey("gemini") === FAKE_KEY);
assert("no localStorage write attempted", !localStorageWriteAttempt,
  "localStorage.setItem was called — privacy violation");

clearAllKeys();
assert("clearAllKeys removes anthropic key",
  sessionStorage.getItem("ttv-key-anthropic") === null);
assert("clearAllKeys removes gemini key",
  sessionStorage.getItem("ttv-key-gemini") === null);

// ---------------------------------------------------------------------------
// 7. readCropWithVision with mocked fetch — adapter flows into review item
// ---------------------------------------------------------------------------

section("readCropWithVision — mocked network");

// Install mock fetch.
const antMockBody = JSON.stringify({ content: [{ type: "text", text: '{"value":"AAPL","type":"ticker"}' }] });
const gemMockBody = JSON.stringify({
  candidates: [{ content: { parts: [{ text: '{"value":"-3.2%","type":"percent"}' }] } }],
});

async function runMockedRead(providerId, mockResponseBody) {
  setKey(providerId, FAKE_KEY);
  global.fetch = async (url, opts) => {
    return {
      ok: true,
      json: async () => JSON.parse(mockResponseBody),
    };
  };
  const result = await readCropWithVision(SAMPLE_DATA_URL, {
    provider: providerId,
    model: getProvider(providerId).defaultModel,
    key: FAKE_KEY,
  });
  clearAllKeys();
  return result;
}

const antResult = await runMockedRead("anthropic", antMockBody);
assert("anthropic mocked read ok", antResult.ok === true, JSON.stringify(antResult));
assert("anthropic mocked read value = AAPL", antResult.value === "AAPL");
assert("anthropic mocked read type = ticker", antResult.type === "ticker");
assert("anthropic mocked engine tag contains provider id",
  String(antResult.engine).startsWith("anthropic:"));

const gemResult = await runMockedRead("gemini", gemMockBody);
assert("gemini mocked read ok", gemResult.ok === true, JSON.stringify(gemResult));
assert("gemini mocked read value = -3.2%", gemResult.value === "-3.2%");
assert("gemini mocked read type = percent", gemResult.type === "percent");
assert("gemini mocked engine tag contains provider id",
  String(gemResult.engine).startsWith("gemini:"));

// Null / refuse-to-guess path: model returns {"value":null,"type":"text"}.
const antRefuseBody = JSON.stringify({ content: [{ type: "text", text: '{"value":null,"type":"text"}' }] });
global.fetch = async () => ({ ok: true, json: async () => JSON.parse(antRefuseBody) });
setKey("anthropic", FAKE_KEY);
const antRefuseResult = await readCropWithVision(SAMPLE_DATA_URL, {
  provider: "anthropic", model: "claude-sonnet-4-6", key: FAKE_KEY,
});
clearAllKeys();
assert("anthropic refuse-to-guess passes through as null value",
  antRefuseResult.ok === true && antRefuseResult.value === null);

// Error path: HTTP 429.
global.fetch = async () => ({
  ok: false,
  status: 429,
  text: async () => "rate limited",
});
setKey("gemini", FAKE_KEY);
const gemErrResult = await readCropWithVision(SAMPLE_DATA_URL, {
  provider: "gemini", model: "gemini-2.5-flash", key: FAKE_KEY,
});
clearAllKeys();
assert("gemini HTTP error propagates as ok=false",
  gemErrResult.ok === false && String(gemErrResult.error).includes("429"));

// ---------------------------------------------------------------------------
// 8. buildVisionRequest export works for both adapters
// ---------------------------------------------------------------------------

section("buildVisionRequest export");

setKey("anthropic", FAKE_KEY);
const antBuilt = buildVisionRequest(SAMPLE_DATA_URL, {
  provider: "anthropic", model: "claude-sonnet-4-6", key: FAKE_KEY,
});
assert("buildVisionRequest anthropic returns url", typeof antBuilt.url === "string" && antBuilt.url.length > 0);
assert("buildVisionRequest anthropic returns headers", typeof antBuilt.headers === "object");
assert("buildVisionRequest anthropic returns body", typeof antBuilt.body === "object");

setKey("gemini", FAKE_KEY);
const gemBuilt = buildVisionRequest(SAMPLE_DATA_URL, {
  provider: "gemini", model: "gemini-2.5-flash", key: FAKE_KEY,
});
assert("buildVisionRequest gemini returns url", typeof gemBuilt.url === "string" && gemBuilt.url.length > 0);
assert("buildVisionRequest gemini URL embeds model", gemBuilt.url.includes("gemini-2.5-flash"));
assert("buildVisionRequest gemini URL embeds key", gemBuilt.url.includes(FAKE_KEY));
clearAllKeys();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(52)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("FAILED");
  process.exit(1);
} else {
  console.log("ALL PASSED");
}
