// store.js — the persistent OPEN-POSITIONS store and its merge model.
//
// THE CONCEPTUAL FIX lives here. LP Ledger REPLACES Ryan's hand-kept sheet, so
// the sheet is the OUTPUT, not the input. Inputs are the tastytrade BROKER
// screens:
//   - Active/Positions Monitor (Type E) → LIVE fields, refreshed every drop.
//   - Order ticket / Curve (Type C)     → STATIC fields, captured ONCE at open.
// A stored position carries both, keyed by identity so a re-drop updates in
// place instead of double-booking. Parsed data ONLY — never image bytes.
//
// A book row keeps the 10 spreadsheet field names (so the seed + the existing
// render + JSON backups all still work) and ADDS live + lifecycle fields.

import { deriveRiskType, derivePositionType, numOrNull } from "./engine.js";

const STATIC_FIELDS = ["credit_rcvd", "debit_paid", "max_profit", "max_loss", "bp_usd", "bp_pct"];
const LIVE_FIELDS = ["pl_open", "pl_open_pct", "mark", "trade_price", "days_open", "dte"];

// ---- identity --------------------------------------------------------------
export function extractSymbol(desc) {
  if (!desc) return null;
  // futures (/6EU6 — digit after the slash) or an equity ticker.
  const m = String(desc).trim().match(/^\/[A-Z0-9]{1,6}|^[A-Z]{1,6}/);
  return m ? m[0].toUpperCase() : null;
}

function legSig(l) { return [l.expiry || "", l.strike ?? "", l.right || ""].join("/"); }

// Identity key for any stored book row OR a freshly parsed monitor position.
// options: symbol + sorted option-leg signature; futures/stock: symbol + date.
export function positionKey(p) {
  const sym = (p.symbol || extractSymbol(p.trade_description) || "").toUpperCase();
  const legs = (p.legs || []).filter((l) => l.right).map(legSig).sort();
  if (legs.length) return sym + "|" + legs.join(",");
  if (p.strategy) return sym + "|" + String(p.strategy).toLowerCase().replace(/\s*w\/.*$/, "").trim();
  return sym + "|" + (p.date_opened || "pos");
}

// ---- monitor position → book row -------------------------------------------
function isoDateMinusDays(captureDate, days) {
  if (days == null) return "";
  const base = captureDate ? new Date(captureDate) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  base.setDate(base.getDate() - days);
  return base.toISOString().slice(0, 10);
}

function describePosition(mp) {
  const parts = [mp.symbol];
  if (mp.strategy) parts.push(mp.strategy);
  else if (mp.legs && mp.legs.length) {
    const l = mp.legs[0];
    parts.push([l.expiry, l.strike, l.right].filter((x) => x != null && x !== "").join(" "));
  }
  return parts.filter(Boolean).join(" ");
}

export function bookRowFromMonitor(mp, captureDate) {
  const trade_description = describePosition(mp);
  const risk_type = deriveRiskType(`${mp.strategy || ""} ${trade_description}`);
  const row = {
    id: "live-" + Math.random().toString(36).slice(2, 9),
    key: positionKey(mp),
    symbol: mp.symbol, strategy: mp.strategy || null, legs: mp.legs || [],
    trade_description,
    // STATIC — unknown until a ticket/curve is captured.
    credit_rcvd: null, debit_paid: null, max_profit: null, max_loss: null,
    bp_usd: null, bp_pct: null, static_source: null,
    // LIVE — straight from the monitor.
    pl_open: mp.pl_open ?? null, pl_open_pct: mp.pl_open_pct ?? null,
    mark: mp.mark ?? null, trade_price: mp.trade_price ?? null,
    days_open: mp.days_open ?? null, dte: mp.dte ?? null,
    live_updated: captureDate || new Date().toISOString().slice(0, 10),
    // user tags / lifecycle — Core/Supp defaulted by his real definition, editable.
    position_type: derivePositionType(mp.symbol || trade_description),
    risk_type: risk_type || null,
    risk_type_source: risk_type ? "derived" : null,
    date_opened: isoDateMinusDays(captureDate, mp.days_open),
    needsStatic: true, closed: false, src: "live",
  };
  return row;
}

// ---- matching --------------------------------------------------------------
function matchIndex(openBook, mp) {
  const key = positionKey(mp);
  let i = openBook.findIndex((r) => (r.key || positionKey(r)) === key && !r.closed);
  if (i >= 0) return i;
  // fallback: same symbol, share at least one option-leg signature.
  const sigs = new Set((mp.legs || []).filter((l) => l.right).map(legSig));
  if (sigs.size) {
    i = openBook.findIndex((r) => !r.closed && r.symbol === mp.symbol &&
      (r.legs || []).some((l) => sigs.has(legSig(l))));
    if (i >= 0) return i;
  }
  // fallback: same symbol, no live data yet (adopt a seed/import row).
  i = openBook.findIndex((r) => !r.closed && !r.live_updated &&
    (r.symbol === mp.symbol || extractSymbol(r.trade_description) === mp.symbol));
  return i;
}

// ---- THE MERGE: refresh LIVE fields from a monitor drop --------------------
// Updates matched positions in place; adds newly-seen ones (flagged needsStatic
// so the one-time ticket capture is prompted). Returns counts for the log.
export function mergeMonitorIntoBook(openBook, monitorPositions, captureDate) {
  const book = openBook.slice();
  let updated = 0, added = 0;
  const seenKeys = new Set();
  for (const mp of monitorPositions) {
    if (!mp.symbol) continue;
    const i = matchIndex(book, mp);
    if (i >= 0) {
      const r = book[i];
      for (const f of LIVE_FIELDS) if (mp[f] != null) r[f] = mp[f];
      r.live_updated = captureDate || new Date().toISOString().slice(0, 10);
      if (!r.legs || !r.legs.length) r.legs = mp.legs || [];
      if (!r.symbol) r.symbol = mp.symbol;
      if (!r.strategy && mp.strategy) r.strategy = mp.strategy;
      if (!r.key) r.key = positionKey(r);
      r.closed = false;
      seenKeys.add(r.key);
      updated++;
    } else {
      const row = bookRowFromMonitor(mp, captureDate);
      book.push(row); seenKeys.add(row.key); added++;
    }
  }
  return { book, updated, added, seenKeys };
}

// A position that has live data but was NOT seen on this full monitor drop is
// treated as closed (it dropped off the blotter). Seed/import rows that never
// carried live data are left untouched (they're back-fill, not the live book).
export function reconcileClosed(openBook, seenKeys) {
  let closed = 0;
  for (const r of openBook) {
    if (r.src === "live" && r.live_updated && !seenKeys.has(r.key || positionKey(r)) && !r.closed) {
      r.closed = true; closed++;
    }
  }
  return closed;
}

// ---- STATIC capture: apply a ticket/curve to a position --------------------
// Fills the static fields on the best-matching open position. If none matches
// yet (ticket captured before the position shows on a monitor), returns matched
// false so the caller can hold it as a pending capture.
export function applyTicketToBook(openBook, ticket, captureDate) {
  const mp = {
    symbol: ticket.symbol,
    legs: (ticket.legs || []).map((l) => ({ strike: l.strike, right: l.right, expiry: l.expiry || "" })),
    strategy: ticket.strategy || null,
  };
  let i = matchIndex(openBook, mp);
  if (i < 0 && ticket.symbol) {
    i = openBook.findIndex((r) => !r.closed && (r.symbol === ticket.symbol || extractSymbol(r.trade_description) === ticket.symbol));
  }
  if (i < 0) return { matched: false };
  const r = openBook[i];
  let filled = 0;
  for (const f of STATIC_FIELDS) {
    if (ticket[f] != null) { r[f] = ticket[f]; filled++; }
  }
  if (filled) { r.static_source = "ticket"; r.needsStatic = false; }
  return { matched: true, row: r, filled };
}

// ---- Capital Requirement CSV: fill BP usage on the open book ---------------
// tastytrade's Capital Requirement report is grouped by UNDERLYING, so each row
// is the buying-power requirement for one symbol. We attribute it to an open
// position only when the symbol matches EXACTLY ONE live row — a symbol with
// several open positions (two SPY spreads) can't be split across legs from a
// grouped total, so those are left for the portfolio summary only (the caller
// still sums every row into the headline BP-usage figure). BP is one of the
// several "static" fields, so needsStatic is left intact (the ticket still
// supplies Max P/L + credit/debit).
export function applyCapReqToBook(openBook, capReq, captureDate) {
  const rows = (capReq && capReq.rows) || [];
  let filled = 0, updated = 0, ambiguous = 0;
  const unmatched = [];
  for (const cr of rows) {
    const sym = (cr.symbol || "").toUpperCase();
    if (!sym) continue;
    const matches = openBook.filter((r) => !r.closed &&
      ((r.symbol || "").toUpperCase() === sym || extractSymbol(r.trade_description) === sym));
    if (matches.length === 0) { unmatched.push(sym); continue; }
    if (matches.length > 1) { ambiguous++; continue; }
    const r = matches[0];
    const had = r.bp_usd != null;
    let touched = false;
    if (cr.bp_usd != null) { r.bp_usd = cr.bp_usd; touched = true; }
    if (cr.bp_pct != null) { r.bp_pct = cr.bp_pct; touched = true; }
    if (touched) {
      r.bp_source = "capreq";
      r.bp_asof = captureDate || new Date().toISOString().slice(0, 10);
      if (!r.static_source) r.static_source = "capreq";
      had ? updated++ : filled++;
    }
  }
  return { filled, updated, ambiguous, unmatched };
}

// ---- one-time history import (DEMOTED Type A spreadsheet path) --------------
// Back-fill only: merge OCR'd spreadsheet rows into the store WITHOUT wiping
// live/ticket positions. Existing rows are enriched; unseen rows are appended.
export function importSpreadsheetIntoBook(openBook, positions) {
  const book = openBook.slice();
  let added = 0, enriched = 0;
  for (const p of positions) {
    const sym = extractSymbol(p.trade_description);
    const cand = { symbol: sym, trade_description: p.trade_description, strategy: null, legs: [] };
    let i = book.findIndex((r) => !r.closed &&
      (r.symbol === sym || extractSymbol(r.trade_description) === sym) &&
      (r.trade_description || "").toLowerCase() === (p.trade_description || "").toLowerCase());
    if (i < 0) i = matchIndex(book, cand);
    // back-fill fallback: a same-symbol live position that has no static yet —
    // the imported history IS that static (credit/max/BP). Enrich, don't dupe.
    if (i < 0 && sym) {
      i = book.findIndex((r) => !r.closed && r.static_source == null &&
        (r.symbol === sym || extractSymbol(r.trade_description) === sym));
    }
    if (i >= 0) {
      const r = book[i];
      for (const f of STATIC_FIELDS) if (r[f] == null && p[f] != null) { r[f] = p[f]; }
      if (!r.date_opened && p.date_opened) r.date_opened = p.date_opened;
      if (p.static_source == null) r.static_source = r.static_source || "import";
      enriched++;
    } else {
      book.push({ ...p, id: p.id || "imp-" + Math.random().toString(36).slice(2, 9),
        symbol: sym, key: positionKey(cand), static_source: "import", src: "import", closed: false });
      added++;
    }
  }
  return { book, added, enriched };
}

// ---- the OUTPUT view: assemble the 10-column sheet from the store ----------
export function activeBook(openBook) { return (openBook || []).filter((r) => !r.closed); }

export const STORE_STATIC_FIELDS = STATIC_FIELDS;
export const STORE_LIVE_FIELDS = LIVE_FIELDS;
