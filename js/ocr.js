// ocr.js — in-browser OCR of tastytrade screenshots (Tesseract.js / WASM).
// Everything runs on-device. Ported from tt_ocr.py: layout detection
// (brightness + aspect + keyword), gridline column/row segmentation for the
// Type A "Positions Spreadsheet", plus parsers for Order Chains (Type B) and the
// dark Active/Positions Monitor (Type E). NEVER fabricates — low-confidence reads
// emit null + a "needs review" flag.

import { numOrNull, deriveRiskType } from "./engine.js";
import { validateCell, cellConfidence, severityFor } from "./validators.js";

// In-session image registry: imageId -> source canvas. Lets the review UI show
// the exact cropped SOURCE PIXELS a value came from. NEVER persisted to disk or
// localStorage — lives only in memory for the current session.
const _imageRegistry = new Map();
let _imgSeq = 0;
export function getImage(id) { return _imageRegistry.get(id) || null; }
export function forgetImages() { _imageRegistry.clear(); }
export function cropToDataUrl(id, bbox, pad = 4, scale = 3) {
  const canvas = _imageRegistry.get(id);
  if (!canvas || !bbox) return null;
  const sx = Math.max(0, Math.floor(bbox.left - pad));
  const sy = Math.max(0, Math.floor(bbox.top - pad));
  const sw = Math.min(canvas.width - sx, Math.ceil(bbox.width + pad * 2));
  const sh = Math.min(canvas.height - sy, Math.ceil(bbox.height + pad * 2));
  if (sw <= 1 || sh <= 1) return null;
  const c = document.createElement("canvas");
  c.width = sw * scale; c.height = sh * scale;
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = false;
  cx.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

const TESS_VERSION = "5.1.1";
const TESS_CDN = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/tesseract.min.js`;

let _worker = null;
let _tessLoaded = false;

// The on-device OCR engine (Tesseract.js core/wasm + eng.traineddata, ~12MB) is
// fetched from a CDN on first use, then cached by the service worker for offline
// use. A COLD first visit while offline therefore can't OCR — surface that
// honestly instead of a cryptic "Failed to load" stack.
const OFFLINE_MSG =
  "OCR engine isn't cached yet (~12MB). It downloads once on first use, then works offline. " +
  "You appear to be offline — connect to the internet for your first OCR, then it's available offline afterward.";

export async function ensureTesseract(progressCb) {
  if (_worker) return _worker;
  try {
    if (!_tessLoaded) {
      await loadScript(TESS_CDN);
      _tessLoaded = true;
    }
    // eslint-disable-next-line no-undef
    _worker = await Tesseract.createWorker("eng", 1, {
      logger: (m) => progressCb && progressCb(m),
    });
    return _worker;
  } catch (err) {
    // distinguish "couldn't fetch the engine" (offline / CDN down) from a real bug
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error(OFFLINE_MSG);
    throw new Error(OFFLINE_MSG + " (" + (err && err.message ? err.message : "load failed") + ")");
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
export function fileToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(blob);
  });
}

function imageToCanvas(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext("2d").drawImage(img, 0, 0);
  return c;
}

function grayscale(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    g[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  return g;
}

function meanBrightness(g) {
  let s = 0;
  for (let i = 0; i < g.length; i++) s += g[i];
  return s / g.length;
}

// ---------------------------------------------------------------------------
// Layout detection (port of tt_ocr.detect_layout, + monitor/ticket)
// ---------------------------------------------------------------------------
export function detectLayout(canvas, gray, ocrText) {
  const w = canvas.width, h = canvas.height, aspect = w / h;
  if (ocrText) {
    const t = ocrText.toLowerCase();
    if (t.includes("trade description") && t.includes("date opened")) return "spreadsheet";
    if (t.includes("portfolio summary") && t.includes("position mix")) return "spreadsheet";
    if (t.includes("order chains") || (t.includes("total p/l") && t.includes("avg trd"))) return "order_chains";
    if ((t.includes("p/l open") || t.includes("p/l opn")) && t.includes("days to expiration")) return "monitor";
    if (t.includes("bp eff") || (t.includes("max profit") && t.includes("pop"))) return "curve";
    if (t.includes("fill") && (t.includes("gtc") || t.includes("limit"))) return "ticket";
  }
  const bright = meanBrightness(gray);
  if (bright > 180) return "spreadsheet";
  if (w <= 760 && aspect >= 0.85 && aspect <= 1.2) return "order_chains";
  if (aspect >= 1.35) return bright < 60 ? "monitor" : "curve"; // wide dark grid = monitor
  return w <= 760 ? "order_chains" : "monitor";
}

// ---------------------------------------------------------------------------
// Gridline detection (port of tt_ocr.detect_gridlines) — pure pixel scan
// ---------------------------------------------------------------------------
function detectGridlines(gray, w, axis, region, lineFrac = 0.55) {
  const [l, t, r, b] = region;
  const hits = [];
  if (axis === "x") {
    const denom = Math.max(1, b - t);
    for (let x = l; x < r; x++) {
      let nonwhite = 0;
      for (let y = t; y < b; y++) if (gray[y * w + x] < 245) nonwhite++;
      if (nonwhite / denom > lineFrac) hits.push(x);
    }
  } else {
    const denom = Math.max(1, r - l);
    for (let y = t; y < b; y++) {
      let nonwhite = 0;
      for (let x = l; x < r; x++) if (gray[y * w + x] < 245) nonwhite++;
      if (nonwhite / denom > lineFrac) hits.push(y);
    }
  }
  const merged = [];
  for (const v of hits) {
    if (merged.length && v - merged[merged.length - 1][merged[merged.length - 1].length - 1] <= 3) {
      merged[merged.length - 1].push(v);
    } else merged.push([v]);
  }
  return merged.map((grp) => Math.round(grp.reduce((a, c) => a + c, 0) / grp.length));
}

const SPREADSHEET_COLUMNS = [
  "trade_description", "credit_rcvd", "debit_paid", "max_profit", "max_loss",
  "bp_usd", "bp_pct", "position_type", "risk_type", "date_opened",
];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
export function parseMoney(text) {
  if (!text) return null;
  let t = String(text).replace(/,/g, "").replace(/\s/g, "");
  const neg = (t.startsWith("(") && t.endsWith(")")) || t.startsWith("-");
  // C2: REFUSE multi-dot input. "1,250.50" misread as "1.250.50" must NOT be
  // truncated to its 1.25 prefix and silently booked 1000x wrong — return null
  // so the cell is flagged for review instead.
  const core = t.replace(/[()$+]/g, "").replace(/^-/, "");
  if ((core.match(/\./g) || []).length > 1) return null;
  const m = t.match(/-?\d+(\.\d{1,2})?/);
  if (!m) return null;
  const val = Math.abs(parseFloat(m[0]));
  return neg ? -val : val;
}

// Tolerant numeric parse for the Monitor/Curve screens: handles leading-dot
// micro-decimals (futures marks like ".0000151" / "-.0000230"), arbitrary
// decimal places, thousands commas, and parenthesised negatives. parseMoney
// (2dp-capped) stays the parser for the dollar grids.
export function parseNum(text) {
  if (text == null) return null;
  let s = String(text).replace(/,/g, "").replace(/[$\s]/g, "");
  if (!s || s === "-" || s === "—") return null;
  const paren = s.startsWith("(") && s.endsWith(")");
  if (paren) s = "-" + s.slice(1, -1);
  const m = s.match(/-?\.?\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
}

// ∞ → "inf"; blank/dash → null; else money.
// IMPORTANT: only the ∞ glyph or a literal "inf"/"infinity" word means Unlimited.
// "00"/"oo" were previously treated as infinity, which turned a real $0 (or an
// OCR'd zero) into "Unlimited" — a magnitude error. A zero is a zero.
export function parseInf(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t || t === "-" || t === "—") return null;
  if (t.includes("∞") || /^(inf|infinity)$/i.test(t)) return "inf";
  return parseMoney(t);
}

// Treasury bond-tick notation: 109'12 = 109 + 12/32 (NOT decimal). Returns {value, raw}.
export function parseBondTick(text) {
  if (!text) return null;
  const m = String(text).match(/(-?\d+)'(\d{1,2})/);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  const ticks = parseInt(m[2], 10);
  const sign = whole < 0 ? -1 : 1;
  return { value: Math.abs(whole) * sign + (sign * ticks) / 32, raw: m[0], notation: "32nds" };
}

export function parseTicker(text) {
  if (!text) return null;
  let t = String(text).replace(/order\s*chains/i, "").trim().toUpperCase();
  const m = t.match(/\/?[A-Z0-9]{1,6}/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// OCR a sub-rectangle of a canvas. dark=true → invert (light-on-dark UI text).
// ---------------------------------------------------------------------------
async function ocrRect(worker, canvas, rect, opts = {}) {
  const { dark = false, psm = 7, whitelist = null, scale = 2 } = opts;
  const sx = Math.max(0, Math.floor(rect.left));
  const sy = Math.max(0, Math.floor(rect.top));
  const sw = Math.min(canvas.width - sx, Math.ceil(rect.width));
  const sh = Math.min(canvas.height - sy, Math.ceil(rect.height));
  if (sw <= 1 || sh <= 1) return { text: "", confidence: 0 };
  const c = document.createElement("canvas");
  c.width = sw * scale; c.height = sh * scale;
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = true;
  cx.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
  // grayscale (+ optional invert + light threshold)
  const id = cx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    if (dark) v = 255 - v;
    v = v < 135 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  cx.putImageData(id, 0, 0);
  const params = { tessedit_pageseg_mode: String(psm) };
  if (whitelist) params.tessedit_char_whitelist = whitelist;
  await worker.setParameters(params);
  const { data } = await worker.recognize(c);
  return { text: (data.text || "").trim(), confidence: data.confidence || 0 };
}

const LOW_CONF = 55; // below this, treat numeric reads as "needs review"

// ---------------------------------------------------------------------------
// TIER 1 — Type A Positions Spreadsheet
// ---------------------------------------------------------------------------
async function extractSpreadsheet(worker, canvas, gray, imageId) {
  const w = canvas.width, h = canvas.height;
  const flags = [];
  const reviewItems = [];
  // Grid lives left of the Portfolio Summary side card. Detect ROW lines first
  // (they span the table width well), then scan COLUMN lines only within the
  // table's vertical band — robust to short / bottom-cropped sheets.
  const tableRight = Math.floor(w * 0.7);
  let hlines = detectGridlines(gray, w, "y", [0, 0, tableRight, h]);
  const bandTop = hlines.length >= 2 ? hlines[0] : 0;
  const bandBot = hlines.length >= 2 ? hlines[hlines.length - 1] : h;
  let vlines = detectGridlines(gray, w, "x", [0, bandTop, tableRight, bandBot]);

  const nCols = SPREADSHEET_COLUMNS.length;
  if (vlines.length < nCols + 1 || hlines.length < 3) {
    flags.push(`GRID_NOT_FOUND: found ${vlines.length} vlines / ${hlines.length} hlines (need ${nCols + 1}/3+). Try a sharper, full-width crop.`);
    return { layout: "spreadsheet", positions: [], reviewItems, geometry: { vlines, hlines }, flags };
  }
  const xedges = vlines.slice(0, nCols + 1);

  // bottom-cropped detection: if the last hline isn't near the image bottom,
  // rows below the fold are missing.
  const bottomGap = h - hlines[hlines.length - 1];
  if (bottomGap > h * 0.08) flags.push("BOTTOM_CROPPED: sheet appears cut off; rows below the last gridline are missing from this screenshot.");

  const moneyCols = new Set(["credit_rcvd", "debit_paid", "max_profit", "max_loss", "bp_usd", "bp_pct"]);
  const positions = [];
  for (let ri = 1; ri < hlines.length - 1; ri++) {
    const y0 = hlines[ri], y1 = hlines[ri + 1];
    if (y1 - y0 < 8) continue;
    const rec = { id: "ocr-" + Math.random().toString(36).slice(2, 8) };
    const cellMeta = {}; // per-field {bbox, conf, raw} for the review crops
    let anyText = false;
    for (let ci = 0; ci < nCols; ci++) {
      const col = SPREADSHEET_COLUMNS[ci];
      const cx0 = xedges[ci], cx1 = xedges[ci + 1];
      const isText = col === "trade_description" || col === "position_type" || col === "risk_type";
      const isDate = col === "date_opened";
      const bbox = { left: cx0 + 1, top: y0 + 1, width: cx1 - cx0 - 2, height: y1 - y0 - 2 };
      const { text, confidence } = await ocrRect(worker, canvas, bbox, {
        dark: false, psm: 7,
        whitelist: isText ? null : (isDate ? "0123456789/-" : "0123456789.,∞-/%"),
      });
      if (text) anyText = true;
      const parsed = moneyCols.has(col) ? parseInf(text) : (text || null);
      rec[col] = parsed;
      cellMeta[col] = { bbox, conf: confidence, raw: text };
    }
    if (!anyText) continue;
    // auto-derive Risk Type if the column read blank
    if (!rec.risk_type) {
      const d = deriveRiskType(rec.trade_description);
      if (d) { rec.risk_type = d; rec.risk_type_source = "derived"; }
    }
    rec.position_type = normPos(rec.position_type);
    rec.risk_type = normRisk(rec.risk_type);
    rec.src = "ocr";

    // validate every cell; confidence = min(ocr, validator). Build review items
    // only for cells that don't auto-accept (green). Keep the OCR value for revert.
    rec._ocr = {};
    for (const col of SPREADSHEET_COLUMNS) {
      const meta = cellMeta[col];
      if (!meta) continue;
      rec._ocr[col] = rec[col];
      const validation = validateCell(col, meta.raw, rec[col]);
      const conf = cellConfidence(meta.conf, validation);
      const sev = severityFor(conf, validation);
      // A blank cell that validates fine (e.g. credit XOR debit) is an
      // intentional empty, not a misread — don't clog the queue with it.
      const isBlank = !meta.raw || !meta.raw.trim();
      if (sev && !(isBlank && validation.ok)) {
        rec.needsReview = true;
        reviewItems.push({
          id: "rv-" + Math.random().toString(36).slice(2, 9),
          kind: "book", rowId: rec.id, field: col,
          desc: rec.trade_description || "(row)",
          value: rec[col], suggested: validation.suggested,
          confidence: Math.round(conf), severity: sev, msg: validation.msg,
          imageId, bbox: meta.bbox, confirmed: false,
        });
      }
    }
    positions.push(rec);
  }
  if (reviewItems.length) flags.push(`REVIEW: ${reviewItems.length} cell(s) need confirmation (open the Review tab).`);
  return { layout: "spreadsheet", positions, reviewItems, geometry: { vlines, hlines }, flags };
}

function normPos(v) {
  if (!v) return v;
  if (/^core/i.test(v)) return "Core";
  if (/^supp/i.test(v)) return "Supp";
  return v;
}
function normRisk(v) {
  if (!v) return v;
  if (/^undef/i.test(v)) return "Undef";
  if (/^def/i.test(v)) return "Def";
  return v;
}

// ---------------------------------------------------------------------------
// TIER 2 — Type B Order Chains (dark). Only fully-CLSD chains book realized P&L.
// ---------------------------------------------------------------------------
const ORDER_CHAINS_REGIONS = {
  ticker:    { left: 0.0, top: 0.0, right: 0.55, bottom: 0.075 },
  total_pl:  { left: 0.5, top: 0.27, right: 0.82, bottom: 0.36 },
  body:      { left: 0.0, top: 0.36, right: 1.0, bottom: 1.0 },
};

async function extractOrderChains(worker, canvas, imageId) {
  const w = canvas.width, h = canvas.height;
  const flags = [];
  const reviewItems = [];
  const rel = (r) => ({ left: r.left * w, top: r.top * h, width: (r.right - r.left) * w, height: (r.bottom - r.top) * h });
  const tickerBox = rel(ORDER_CHAINS_REGIONS.ticker);
  const totalBox = rel(ORDER_CHAINS_REGIONS.total_pl);

  const tk = await ocrRect(worker, canvas, tickerBox, { dark: true, psm: 7 });
  let ticker = parseTicker(tk.text);
  const tot = await ocrRect(worker, canvas, totalBox, { dark: true, psm: 7, whitelist: "0123456789.,'-()" });
  const body = await ocrRect(worker, canvas, rel(ORDER_CHAINS_REGIONS.body), { dark: true, psm: 6 });

  let totalPl = parseMoney(tot.text);
  let bondTick = null;
  if (tot.text && /'/.test(tot.text)) {
    bondTick = parseBondTick(tot.text);
    if (bondTick) { totalPl = bondTick.value; flags.push(`BOND_TICK: parsed '${bondTick.raw}' as ${bondTick.value} (points + 32nds), not decimal.`); }
  }

  const bodyText = (body.text || "").toLowerCase();
  // Gate: any "open pos" block => chain still live, do NOT book.
  const hasOpen = /open\s*pos/.test(bodyText);
  const hasClsd = /clsd|clos(ing|ed)/.test(bodyText);
  let isClosed = null;
  if (hasOpen) isClosed = false;
  else if (hasClsd) isClosed = true;

  if (isClosed === false) flags.push("OPEN_POS: chain contains an open block — treated as live/unrealized, not booked as realized P&L.");
  if (isClosed === null) flags.push("STATUS_UNKNOWN: could not confirm CLSD vs open; not booked as realized (review).");
  if (!ticker) { ticker = null; flags.push("LOW_CONFIDENCE:ticker (may be cropped off the top — set it manually)."); }
  if (totalPl === null) flags.push("LOW_CONFIDENCE:total_pl");

  // strategy guess from body keywords
  const strat = guessStrategy(bodyText);

  // Only a CLSD chain produces a bookable realized number — review THAT number.
  const bookable = isClosed === true && totalPl !== null;
  const tradeId = "ocr-" + Math.random().toString(36).slice(2, 8);
  if (bookable) {
    const vTot = validateCell("total_pl", tot.text, totalPl);
    const cTot = cellConfidence(tot.confidence, vTot);
    const sTot = severityFor(cTot, vTot);
    if (sTot) reviewItems.push({
      id: "rv-" + Math.random().toString(36).slice(2, 9), kind: "trade", rowId: tradeId,
      field: "pl", desc: `${ticker || "?"} realized P/L`, value: totalPl, suggested: vTot.suggested,
      confidence: Math.round(cTot), severity: sTot, msg: vTot.msg || (bondTick ? `bond-tick ${bondTick.raw}` : ""),
      imageId, bbox: totalBox, confirmed: false,
    });
    const vTk = validateCell("ticker", tk.text, ticker);
    const cTk = cellConfidence(tk.confidence, vTk);
    const sTk = severityFor(cTk, vTk);
    if (sTk) reviewItems.push({
      id: "rv-" + Math.random().toString(36).slice(2, 9), kind: "trade", rowId: tradeId,
      field: "ticker", desc: "Order Chain ticker", value: ticker, suggested: vTk.suggested,
      confidence: Math.round(cTk), severity: sTk, msg: vTk.msg, imageId, bbox: tickerBox, confirmed: false,
    });
  }

  return {
    layout: "order_chains", tradeId,
    ticker, total_pl: totalPl, is_closed: isClosed,
    strategy: strat, bondTick, confidence: Math.min(tk.confidence, tot.confidence),
    bookable, reviewItems, flags,
  };
}

function guessStrategy(t) {
  // ORDER MATTERS — most specific first (e.g. "double calendar" before "calendar",
  // "iron fly" before "fly"/"butterfly", "risk-free fly" before "fly").
  const map = [
    ["risk-free fly", "Risk-Free Fly"], ["risk free fly", "Risk-Free Fly"],
    ["super bull", "Super Bull"],
    ["broken-wing", "Broken-Wing Butterfly"], ["broken wing", "Broken-Wing Butterfly"],
    ["iron butterfly", "Iron Fly"], ["iron fly", "Iron Fly"],
    ["butterfly", "Butterfly"],
    ["iron condor", "Iron Condor"], ["condor", "Iron Condor"],
    ["double calendar", "Double Calendar"], ["call calendar", "Call Calendar"], ["calendar", "Calendar"],
    ["poor man", "Poor Man's Covered Call"], ["pmcc", "Poor Man's Covered Call"],
    ["call diagonal", "Call Diagonal"], ["put diagonal", "Put Diagonal"], ["diagonal", "Diagonal"],
    ["strangle", "Short Strangle"], ["straddle", "Short Straddle"],
    ["vertical", "Vertical Spread"], ["ratio", "Ratio Spread"],
    ["zebra", "Zebra"], ["futures option", "Futures Option"],
    ["custom", "Custom"], ["option", "Option"],
  ];
  for (const [k, v] of map) if (t.includes(k)) return v;
  return null;
}

// ---------------------------------------------------------------------------
// PRIMARY OPEN-BOOK SOURCE — Type E dark Active/Positions Monitor.
// This is the screen Ryan drops weekly that REPLACES hand-typing his sheet.
// Fixed columns, right-aligned: Symbol | P/L Open | P/L Opn% | Mark | Trade
// Price | D's Opn | Days To Expiration. Three-level row hierarchy:
//   1. Underlying header   colored-dot + TICKER + price chip (day-change|last)
//   2. Strategy row        indented label (Option / Vertical / Custom / Ratio
//                          w/ N rolls / Futures Option w/ a roll / Contracts …)
//   3. Leg row             chip: qty | expiry(Mon DD) | DTE(##d) | strike | P/C
// ---------------------------------------------------------------------------

const STRATEGY_WORDS = /^(contracts|option|vertical|butterfly|calendar|diagonal|custom|ratio|strangle|straddle|zebra|condor|covered|fly|received|futures\s+option|super\s+bull)/i;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const LEG_RE = new RegExp(`(-?\\d+)\\s+(${MONTHS})\\s+(\\d{1,2})\\b`, "i");
// futures (/6EU6, /MESU6 — digit can follow the slash) OR an equity ticker.
const TICKER_HEAD_RE = /^(\/[A-Z0-9]{1,6}|[A-Z]{1,6})$/;

// Split a Monitor row's numeric TAIL off the head. Anchored on the single "%"
// token (P/L Opn% — the one reliable landmark; the price-chip numbers all sit
// LEFT of P/L Open, and the chip's own "##d" sits left of the % too, so we only
// ever look RIGHT of the % for Mark/Trade/D'sOpn/DTE). Returns null if no %.
export function parseMonitorTail(line) {
  const toks = String(line).trim().split(/\s+/);
  let pctIdx = -1;
  for (let i = toks.length - 1; i >= 0; i--) { if (/%$/.test(toks[i])) { pctIdx = i; break; } }
  if (pctIdx < 1) return null;
  const pl_open = parseNum(toks[pctIdx - 1]);
  const pl_open_pct = parseNum(toks[pctIdx]);
  const right = toks.slice(pctIdx + 1);
  // trailing "##d" tokens: last = DTE, the one before it (if any) = D's Opn.
  const dIdx = [];
  right.forEach((t, i) => { if (/^\d+d$/i.test(t)) dIdx.push(i); });
  let dte = null, days_open = null, numEnd = right.length;
  if (dIdx.length >= 1) { dte = parseInt(right[dIdx[dIdx.length - 1]], 10); numEnd = dIdx[0]; }
  if (dIdx.length >= 2) days_open = parseInt(right[dIdx[dIdx.length - 2]], 10);
  // numerics between % and the first ##d are [Mark, Trade Price] in order.
  const mids = right.slice(0, numEnd).map(parseNum).filter((x) => x !== null);
  const mark = mids.length >= 1 ? mids[0] : null;
  const trade_price = mids.length >= 2 ? mids[1] : null;
  const head = toks.slice(0, pctIdx - 1).join(" ");
  return { head, pl_open, pl_open_pct, mark, trade_price, days_open, dte };
}

// Classify a parsed row by its head text → "underlying" | "strategy" | "leg".
function classifyMonitorHead(head) {
  const toks = head.replace(/[•·|]/g, " ").trim().split(/\s+/).filter(Boolean);
  // leg: contains an expiry (Mon DD) and a trailing C/P
  if (LEG_RE.test(head) && /\b[CP]\b\s*$/i.test(head.trim())) return "leg";
  // strategy: leading word is a known strategy label (no leading ticker)
  const firstReal = toks.find((t) => !/^itm$|^am$/i.test(t) && !TICKER_HEAD_RE.test(t)) || toks[0] || "";
  if (STRATEGY_WORDS.test(head.trim()) || STRATEGY_WORDS.test(firstReal)) return "strategy";
  // underlying: some token looks like a ticker (skip ITM/AM badges)
  if (toks.some((t) => !/^itm$|^am$/i.test(t) && TICKER_HEAD_RE.test(t))) return "underlying";
  return "other";
}

function monitorSymbol(head) {
  for (const t of head.replace(/[•·|]/g, " ").trim().split(/\s+/)) {
    if (/^itm$|^am$/i.test(t)) continue;
    if (TICKER_HEAD_RE.test(t)) return t.toUpperCase();
  }
  return null;
}

function parseLegChip(head) {
  const m = head.match(LEG_RE);
  if (!m) return null;
  const qty = parseInt(m[1], 10);
  const expiry = `${cap(m[2])} ${m[3]}`;
  // strike = last numeric token before the trailing C/P; right = that C/P.
  const rm = head.match(/(-?\d+(?:\.\d+)?)\s+([CP])\s*$/i);
  const strike = rm ? parseNum(rm[1]) : null;
  const right = rm ? rm[2].toUpperCase() : null;
  return { qty, expiry, strike, right };
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

// PURE: turn the full multi-line OCR of ONE monitor screenshot into a hierarchy
// of positions (one per strategy row), each carrying live fields + its legs.
export function parseMonitorText(text) {
  const positions = [];
  let curSym = null, curLast = null, curPos = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+$/g, "");
    if (!line.trim()) continue;
    const tail = parseMonitorTail(line);
    if (!tail) continue; // header/labels w/o a % column
    const kind = classifyMonitorHead(tail.head);
    const live = {
      pl_open: tail.pl_open, pl_open_pct: tail.pl_open_pct, mark: tail.mark,
      trade_price: tail.trade_price, days_open: tail.days_open, dte: tail.dte,
    };
    if (kind === "underlying") {
      curSym = monitorSymbol(tail.head) || curSym;
      const chip = (tail.head.match(/-?\d+(?:\.\d+)?/g) || []).map(parseNum);
      curLast = chip.length ? chip[chip.length - 1] : null;
      // an underlying with no later strategy row still defines a position stub;
      // overwritten if a strategy row follows immediately.
      curPos = null;
    } else if (kind === "strategy") {
      curPos = {
        symbol: curSym, underlying_last: curLast,
        strategy: normStrategyLabel(tail.head), legs: [], ...live,
      };
      positions.push(curPos);
    } else if (kind === "leg") {
      const leg = parseLegChip(tail.head);
      if (!curPos) { // legs arriving before any strategy row (e.g. seam carry)
        curPos = { symbol: curSym, underlying_last: curLast, strategy: null, legs: [], ...live };
        positions.push(curPos);
      }
      if (leg) curPos.legs.push({ ...leg, ...live });
    }
  }
  return positions.filter((p) => p.symbol);
}

function normStrategyLabel(head) {
  const h = head.replace(/[•·|]/g, " ").replace(/\s+/g, " ").trim();
  const m = h.match(STRATEGY_WORDS);
  if (!m) return h || null;
  // keep the "w/ N rolls" / "w/ a roll" qualifier when present
  const q = h.match(/w\/\s*(a roll|\d+\s*rolls?)/i);
  let base = m[0].replace(/\s+/g, " ");
  base = base.replace(/^futures option/i, "Futures Option");
  base = cap(base.split(" ")[0]) + (base.includes(" ") ? " " + base.split(" ").slice(1).join(" ") : "");
  if (/futures option/i.test(m[0])) base = "Futures Option";
  return q ? `${base} w/ ${q[1]}` : base;
}

async function extractMonitor(worker, canvas) {
  const flags = [];
  const w = canvas.width, h = canvas.height;
  // full-grid OCR (PSM 6 = uniform block) preserves left→right reading order so
  // each row's numeric tail stays on one line; the pure parser handles the rest.
  const { text, confidence } = await ocrRect(worker, canvas, { left: 0, top: 0, width: w, height: h }, { dark: true, psm: 6, scale: 1.5 });
  const positions = parseMonitorText(text);
  if (confidence < LOW_CONF) flags.push("LOW_CONFIDENCE: monitor grid OCR is faint — confirm the live numbers.");
  if (!positions.length) flags.push("MONITOR_EMPTY: no positions parsed — check this is the dark Active/Positions Monitor.");
  return { layout: "monitor", positions, rawText: text, confidence, flags };
}

// Concatenate the 3 stitched monitor parts (in order) into one position list,
// de-duping at the seams. The seam can BOTH (a) repeat the last position's legs
// at the top of the next part and (b) split one position across two parts. We
// merge by position key (symbol + leg signature) and union legs by signature.
export function mergeMonitorParts(parts) {
  const order = [];
  const byKey = new Map();
  let carry = null; // last position of the previous part (to adopt orphan legs)
  for (const part of parts) {
    const list = Array.isArray(part) ? part : (part.positions || []);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      // orphan legs at the very top of a part (no strategy, same symbol as the
      // carried position) belong to the carried position spanning the seam.
      if (i === 0 && carry && !p.strategy && (!p.symbol || p.symbol === carry.symbol)) {
        for (const leg of p.legs) addLeg(carry, leg);
        continue;
      }
      const key = monitorPositionKey(p);
      if (byKey.has(key)) {
        const ex = byKey.get(key);
        for (const leg of p.legs) addLeg(ex, leg);
        // keep the most complete live fields
        for (const f of ["pl_open", "pl_open_pct", "mark", "trade_price", "days_open", "dte"]) {
          if (ex[f] == null && p[f] != null) ex[f] = p[f];
        }
      } else {
        byKey.set(key, p); order.push(p);
      }
    }
    carry = list.length ? (byKey.get(monitorPositionKey(list[list.length - 1])) || list[list.length - 1]) : carry;
  }
  return order;
}
function addLeg(pos, leg) {
  const sig = legSig(leg);
  if (!pos.legs.some((l) => legSig(l) === sig)) pos.legs.push(leg);
}
function legSig(l) { return [l.expiry || "", l.strike ?? "", l.right || ""].join("/"); }

// Position identity for the store: symbol + sorted option-leg signature; for a
// futures/stock long ("Contracts", no option legs) → symbol + strategy.
export function monitorPositionKey(p) {
  const sym = (p.symbol || "").toUpperCase();
  const legs = (p.legs || []).filter((l) => l.right).map(legSig).sort();
  if (legs.length) return sym + "|" + legs.join(",");
  return sym + "|" + (p.strategy || "pos");
}

// Back-compat shim: older callers used mergeMonitorRows(parts) and expected a
// flat {symbol, plOpen, raw} list. Re-expressed over the structured merge.
export function mergeMonitorRows(parts) {
  return mergeMonitorParts(parts).map((p) => ({
    symbol: p.symbol, plOpen: p.pl_open,
    raw: `${p.strategy || ""} ${p.legs.length ? `(${p.legs.length} legs)` : ""}`.trim(),
  }));
}

// ---------------------------------------------------------------------------
// STATIC-DETAIL SOURCE — Type C Curve / order ticket. Captured ONCE at trade
// open. Supplies the fields that DON'T change after entry: Max Profit, Max Loss,
// BP $, BP %, and Credit Rcvd / Debit Paid. No longer auto-skipped.
// ---------------------------------------------------------------------------

// PURE: pull the static fields from the OCR text of a Curve / ticket screen.
export function parseCurveText(text) {
  const t = String(text || "");
  const flat = t.replace(/\n/g, " ");
  const out = {
    symbol: null, strategy: null,
    max_profit: null, max_loss: null, bp_usd: null, bp_pct: null,
    credit_rcvd: null, debit_paid: null, legs: [],
  };
  // bottom analysis bar: "Max Profit 0   Max Loss 0   BP Eff. 555.00 db"
  const mp = flat.match(/max\s*profit[:\s]*([∞]|inf(?:inity)?|-?[\d.,]+|--)/i);
  if (mp) out.max_profit = parseInf(mp[1]);
  const ml = flat.match(/max\s*loss[:\s]*([∞]|inf(?:inity)?|-?[\d.,]+|--)/i);
  if (ml) out.max_loss = parseInf(ml[1]);
  const bp = flat.match(/bp\s*eff\.?[:\s]*(-?[\d.,]+)\s*(db|cr)?/i);
  if (bp) { out.bp_usd = parseMoney(bp[1]); if (bp[2]) out.bp_basis = bp[2].toLowerCase(); }
  const bpp = flat.match(/bp\s*(?:usage|eff)?\.?\s*%[:\s]*(-?[\d.,]+)/i);
  if (bpp) out.bp_pct = parseNum(bpp[1]);
  // a debit (db) BP basis or a "db" fill → debit; "cr" → credit.
  const fill = flat.match(/(?:fill|net|price)\s*([\d.,]+)\s*(db|cr)/i);
  if (fill) {
    const v = parseMoney(fill[1]);
    if (/cr/i.test(fill[2])) out.credit_rcvd = v; else out.debit_paid = v;
  }
  // symbol: a leading futures (/XXX) or 2-6 char ALLCAPS ticker. Avoid matching
  // single letters from "P/L". Skip a few common UI words just in case.
  const SKIP = /^(THE|BUY|SELL|CALL|PUT|FILL|LMT|GTC|DAY|NET|MAX|BID|ASK|VOL|NYSE|IV)$/;
  for (const tk of (flat.match(/\/[A-Z0-9]{2,6}|[A-Z]{2,6}\d?/g) || [])) {
    if (!SKIP.test(tk)) { out.symbol = tk.toUpperCase(); break; }
  }
  // legs: "BUY 1C 120 Call 8/21" / "SELL -1C 130 Call 7/17" or chip form.
  const legRe = /(buy|sell)\s+(-?\d+)\s*([cp])?\s+([\d.]+)\s*(call|put)/gi;
  let lm;
  while ((lm = legRe.exec(flat))) {
    out.legs.push({
      side: lm[1].toUpperCase(), qty: parseInt(lm[2], 10),
      strike: parseNum(lm[4]), right: /call/i.test(lm[5]) ? "C" : "P",
    });
  }
  return out;
}

async function extractCurve(worker, canvas, imageId) {
  const w = canvas.width, h = canvas.height;
  const flags = [];
  const { text, confidence } = await ocrRect(worker, canvas, { left: 0, top: 0, width: w, height: h }, { dark: true, psm: 6, scale: 1.5 });
  const ticket = parseCurveText(text);
  const got = ["max_profit", "max_loss", "bp_usd", "credit_rcvd", "debit_paid"].filter((k) => ticket[k] != null);
  if (!got.length) flags.push("TICKET_THIN: no static fields read (Max Profit/Loss/BP/credit) — capture or fill manually.");
  if (confidence < LOW_CONF) flags.push("LOW_CONFIDENCE: ticket OCR is faint — confirm the static numbers.");
  return { layout: "curve", ticket, rawText: text, confidence, flags };
}

// ---------------------------------------------------------------------------
// Driver — process one screenshot end-to-end.
// ---------------------------------------------------------------------------
export async function processScreenshot(blob, progressCb) {
  const img = await fileToImage(blob);
  const canvas = imageToCanvas(img);
  const gray = grayscale(canvas.getContext("2d"), canvas.width, canvas.height);
  const worker = await ensureTesseract(progressCb);

  // Keep the source canvas in memory (only) so the review UI can show crops.
  const imageId = "img-" + (++_imgSeq);
  _imageRegistry.set(imageId, canvas);

  // cheap full-image hint OCR for layout detection
  let hint = "";
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "3", tessedit_char_whitelist: "" });
    const { data } = await worker.recognize(canvas);
    hint = data.text || "";
  } catch (e) { /* ignore */ }

  const layout = detectLayout(canvas, gray, hint);
  let result;
  if (layout === "spreadsheet") result = await extractSpreadsheet(worker, canvas, gray, imageId);
  else if (layout === "order_chains") result = await extractOrderChains(worker, canvas, imageId);
  else if (layout === "monitor") result = await extractMonitor(worker, canvas);
  else if (layout === "curve" || layout === "ticket") result = await extractCurve(worker, canvas, imageId);
  else {
    result = { layout, flags: [`SKIPPED: '${layout}' layout carries no track-record data (context only).`] };
    _imageRegistry.delete(imageId); // nothing references it
  }

  result.imageId = imageId;
  result.layout = layout;
  result.detectedFrom = hint ? "keyword+geometry" : "geometry";
  return result;
}

export async function terminateOcr() {
  if (_worker) { await _worker.terminate(); _worker = null; }
}
