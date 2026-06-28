// csv.js — import tastytrade's "Capital Requirement" CSV to fill BP usage.
//
// The Capital Requirement report (tastytrade → positions risk panel → CSV
// button) lists, per open position / underlying: Requirement (Buying Power
// Effect), BP Usage %, Initial (Margin) Requirement and Maintenance
// Requirement. Ryan imports THIS to populate his buying-power usage instead of
// capturing every order ticket/Curve screenshot by hand.
//
// Pure, dependency-free, and TOLERANT by design: tastytrade tweaks the exact
// headers across platform versions, so columns are located by fuzzy header
// ROLE, not a fixed position, and a title/blank preamble before the header row
// is skipped. Same guiding rule as the OCR path: never fabricate — an
// unreadable cell stays null rather than guessing.

// ---- a small RFC-4180-ish CSV reader (quotes, escaped quotes, CRLF, BOM) ----
export function parseCsvText(text) {
  if (text == null) return [];
  const s = String(text).replace(/^﻿/, ""); // strip a UTF-8 BOM
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }   // escaped ""
        else inQ = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* swallow; \n ends the row */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- tolerant number parsing ----------------------------------------------
// Handles "$1,234.50", "(1,234.50)" / leading "-" as negative, "12.5%", and
// the various blanks tastytrade emits. Returns a number or null (never NaN).
export function parseMoney(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t || /^(n\/?a|--|—|–|-|\.)$/i.test(t)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^\s*-/.test(t)) neg = true;
  t = t.replace(/[^0-9.]/g, "");
  if (t === "" || t === ".") return null;
  const n = parseFloat(t);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}
export const parsePct = parseMoney; // strips the % too

function absOrNull(n) { return n == null ? null : Math.abs(n); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ---- header-role detection (fuzzy, priority-ordered) -----------------------
const PATTERNS = {
  symbol:  [/underlying/i, /^symbol$/i, /symbol/i, /ticker/i, /product/i, /instrument/i],
  bp_pct:  [/bp\s*usage/i, /buying\s*power\s*usage/i, /usage\s*%?/i, /%\s*of\s*net\s*liq/i, /net\s*liq.*%/i, /percent/i, /%/],
  initial: [/initial/i],
  maint:   [/maint/i],
  bp_usd:  [/buying\s*power\s*effect/i, /capital\s*requirement/i, /^requirement$/i, /\brequirement\b/i, /buying\s*power/i, /\bcapital\b/i, /\bbp\b/i],
};

function pick(headers, patterns, taken) {
  for (const pat of patterns) {
    for (let i = 0; i < headers.length; i++) {
      if (taken.has(i)) continue;
      if (pat.test(headers[i])) return i;
    }
  }
  return -1;
}

// Map a candidate header row to column roles. % / initial / maintenance are
// claimed FIRST so the generic "...requirement" match for bp_usd can't steal
// the "Initial Requirement" / "Maintenance Requirement" columns.
function mapColumns(headers) {
  const taken = new Set();
  const take = (role) => { const i = pick(headers, PATTERNS[role], taken); if (i >= 0) taken.add(i); return i; };
  const symbol = take("symbol");
  const bp_pct = take("bp_pct");
  const initial = take("initial");
  const maint = take("maint");
  const bp_usd = take("bp_usd");
  return { symbol, bp_usd, bp_pct, initial, maint };
}

function normalizeSymbol(s) {
  const t = String(s).trim().toUpperCase();
  if (!t) return null;
  // futures (/ESU6) or an equity/underlying ticker — same shape store.js keys on.
  const m = t.match(/^\/[A-Z0-9]{1,6}|^[A-Z]{1,6}/);
  return m ? m[0] : t;
}

// ---- the parser ------------------------------------------------------------
// Returns { ok:true, rows:[{symbol,bp_usd,bp_pct,initial,maint}], total:{bp_usd,bp_pct}, columns }
// or { ok:false, reason }.
export function parseCapitalRequirementCsv(text) {
  const all = parseCsvText(text).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!all.length) return { ok: false, reason: "empty file" };

  // Find the header row (tastytrade may prepend a title/blank line or two).
  let headerIdx = -1, cols = null;
  for (let i = 0; i < Math.min(all.length, 12); i++) {
    const h = all[i].map((x) => String(x).trim());
    const c = mapColumns(h);
    if (c.symbol >= 0 && (c.bp_usd >= 0 || c.bp_pct >= 0 || c.maint >= 0 || c.initial >= 0)) {
      headerIdx = i; cols = c; break;
    }
  }
  if (headerIdx < 0) {
    return { ok: false, reason: "not a Capital Requirement CSV (no Symbol + Requirement/BP-Usage columns found)" };
  }

  const rows = [];
  let totalRow = null;
  for (let i = headerIdx + 1; i < all.length; i++) {
    const r = all[i];
    const symRaw = cols.symbol >= 0 ? r[cols.symbol] : "";
    const symStr = String(symRaw || "").trim();
    const bpUsdRaw = cols.bp_usd >= 0 ? absOrNull(parseMoney(r[cols.bp_usd])) : null;
    const initial = cols.initial >= 0 ? absOrNull(parseMoney(r[cols.initial])) : null;
    const maint = cols.maint >= 0 ? absOrNull(parseMoney(r[cols.maint])) : null;
    const bp_pct = cols.bp_pct >= 0 ? parsePct(r[cols.bp_pct]) : null;
    // Effective BP $: prefer the explicit Buying Power Effect / Requirement,
    // else fall back to maintenance, then initial requirement.
    const bp_usd = bpUsdRaw != null ? bpUsdRaw : (maint != null ? maint : initial);

    const isTotal = /^(total|totals|grand\s*total|portfolio|net\s*liq)\b/i.test(symStr);
    if (isTotal || symStr === "") {
      if (bp_usd != null || bp_pct != null) totalRow = { bp_usd, bp_pct };
      continue;
    }
    const symbol = normalizeSymbol(symStr);
    if (!symbol) continue;
    if (bp_usd == null && bp_pct == null) continue; // nothing usable on this line
    rows.push({ symbol, bp_usd, bp_pct, initial, maint });
  }

  if (!rows.length && !totalRow) return { ok: false, reason: "no position rows parsed" };

  const sumUsd = round2(rows.reduce((a, r) => a + (r.bp_usd || 0), 0));
  const sumPct = round2(rows.reduce((a, r) => a + (r.bp_pct || 0), 0));
  const total = {
    bp_usd: totalRow && totalRow.bp_usd != null ? totalRow.bp_usd
      : (rows.some((r) => r.bp_usd != null) ? sumUsd : null),
    bp_pct: totalRow && totalRow.bp_pct != null ? totalRow.bp_pct
      : (rows.some((r) => r.bp_pct != null) ? sumPct : null),
  };
  return { ok: true, rows, total, columns: cols, headerIdx };
}
