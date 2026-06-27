// repoint.test.mjs — headless validation for the OCR re-point (Option A).
// Run: node docs/tt-tracker/js/repoint.test.mjs
//
// No browser/Tesseract is available in CI, so we validate the PURE parsing core
// against text TRANSCRIBED from the real Ryan sample images (weekly-recap-06-19,
// images 12/13/14 = the 3 stitched Active/Positions Monitor parts, image 01 =
// a Type C Curve). The thin canvas/OCR shell (extractMonitor/extractCurve) just
// feeds these functions the OCR'd lines.

import {
  parseMonitorTail, parseMonitorText, mergeMonitorParts, monitorPositionKey,
  parseCurveText, parseInf, parseNum,
} from "./ocr.js";
import {
  mergeMonitorIntoBook, reconcileClosed, applyTicketToBook,
  importSpreadsheetIntoBook, positionKey, bookRowFromMonitor, activeBook,
} from "./store.js";
import { computeTrackRecord, rangeLabel, derivePositionType, deriveRiskType, isAdjustmentOutcome } from "./engine.js";
import { validateCell, cellConfidence, severityFor } from "./validators.js";
import { SEED } from "./seed.js";

let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function eq(label, got, want) { assert(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
function near(label, got, want, tol = 0.001) { assert(label, got != null && Math.abs(got - want) <= tol, `got ${got} want ${want}`); }
function section(n) { console.log(`\n== ${n} ==`); }

// --- transcribed real Monitor lines (06-19 #12 / #13 / #14) -----------------
const PART1 = `/1OZQ6 -73.25 4,172.75 -1,990.00 -8.7% 4,172.75 38d
Contracts 5 -1,990.00 -8.7% 4,172.75 -4,570.75 38d
/6EU6 ITM .00080 1.15090 -910.95 -158.4% -.01189 .00460 2d 48d
Futures Option w/ a roll -910.95 -158.4% -.01189 .00460 2d 48d
-1 Aug 7 48d 1.155 P -60.95 -4.3% -.01189 .01140 2d 48d
/6JU6 .0000125 .0062405 -230.77 -80.3% .0000045 -.0000230 31d 12d
Vertical -230.77 -80.3% .0000045 -.0000230 31d 12d
1 Jul 2 12d 0.0064 C -462.17 -82.2% .0000080 -.0000450 31d 12d
-1 Jul 2 12d 0.0065 C 231.40 84.1% -.0000035 .0000220 31d 12d`;

const PART2 = `/SICN6 -1.42 64.90 -1,215.00 -15.8% 64.90 5d
Contracts 1 -1,215.00 -15.8% 64.90 -77.05 5d
ADBE -1.12 195.16 -625.00 -69.4% 2.75 -9.00 9d 62d
Custom -625.00 -69.4% 2.75 -9.00 9d 62d
1 Aug 21 62d 240 C -998.00 -78.4% 2.75 -12.73 9d 62d
GLD ITM -1.49 387.11 -346.00 -14.4% -27.46 24.00 22d 27d
Ratio w/ 7 rolls -346.00 -14.4% -27.46 24.00 22d 27d
-1 Jul 17 27d 410 P -1,575.00 -175.6% -24.72 8.97 22d 27d
-1 Jul 17 27d 410 C 1,648.00 85.7% -2.74 19.22 22d 27d`;

// part3 REPEATS GLD's two legs at the top (the seam overlap), then META.
const PART3 = `-1 Jul 17 27d 410 P -1,575.00 -175.6% -24.72 8.97 22d 27d
-1 Jul 17 27d 410 C 1,648.00 85.7% -2.74 19.22 22d 27d
META ITM 9.72 577.30 -2,120.00 -11.0% 171.30 -192.50 51d 580d
Option -2,120.00 -11.0% 171.30 -192.50 51d 580d
1 Jan 21 580d 500 C -2,120.00 -11.0% 171.30 -192.50 51d 580d`;

// ---------------------------------------------------------------------------
section("parseMonitorTail — column extraction off the % anchor");
{
  const t = parseMonitorTail("/6EU6 ITM .00080 1.15090 -910.95 -158.4% -.01189 .00460 2d 48d");
  near("P/L Open", t.pl_open, -910.95);
  near("P/L Opn%", t.pl_open_pct, -158.4);
  near("Mark (micro-decimal)", t.mark, -0.01189);
  near("Trade Price", t.trade_price, 0.0046);
  eq("D's Opn", t.days_open, 2);
  eq("DTE", t.dte, 48);

  // underlying header with blank Trade Price + blank D's Opn
  const u = parseMonitorTail("/1OZQ6 -73.25 4,172.75 -1,990.00 -8.7% 4,172.75 38d");
  near("header P/L Open (chip last not mistaken)", u.pl_open, -1990);
  near("header Mark", u.mark, 4172.75);
  eq("header Trade Price blank", u.trade_price, null);
  eq("header D's Opn blank", u.days_open, null);
  eq("header DTE", u.dte, 38);

  // leg row: the ##d INSIDE the chip (head) must not be read as a column
  const leg = parseMonitorTail("1 Jul 2 12d 0.0064 C -462.17 -82.2% .0000080 -.0000450 31d 12d");
  near("leg P/L Open", leg.pl_open, -462.17);
  eq("leg D's Opn (not chip 12d)", leg.days_open, 31);
  eq("leg DTE", leg.dte, 12);
}

section("parseMonitorText — hierarchy: positions + legs");
{
  const p1 = parseMonitorText(PART1);
  const syms = p1.map((p) => p.symbol);
  assert("part1 sees /1OZQ6,/6EU6,/6JU6", syms.includes("/1OZQ6") && syms.includes("/6EU6") && syms.includes("/6JU6"), syms.join(","));
  const eu = p1.find((p) => p.symbol === "/6EU6");
  eq("/6EU6 strategy label", eu.strategy, "Futures Option w/ a roll");
  eq("/6EU6 has 1 leg", eu.legs.length, 1);
  eq("/6EU6 leg right", eu.legs[0].right, "P");
  near("/6EU6 live P/L", eu.pl_open, -910.95);
  const ju = p1.find((p) => p.symbol === "/6JU6");
  eq("/6JU6 Vertical has 2 legs", ju.legs.length, 2);
  const oz = p1.find((p) => p.symbol === "/1OZQ6");
  eq("/1OZQ6 Contracts (futures long)", oz.strategy, "Contracts");
}

section("mergeMonitorParts — stitch + de-dup the seam");
{
  const parts = [parseMonitorText(PART1), parseMonitorText(PART2), parseMonitorText(PART3)];
  const merged = mergeMonitorParts(parts);
  const gld = merged.filter((p) => p.symbol === "GLD");
  eq("GLD appears exactly once (seam de-dup)", gld.length, 1);
  eq("GLD legs unioned to 2 (not 4)", gld[0].legs.length, 2);
  const meta = merged.find((p) => p.symbol === "META");
  assert("META parsed after the seam", !!meta, "META missing");
  eq("META has 1 leg", meta ? meta.legs.length : -1, 1);
  // total distinct positions
  const keys = new Set(merged.map(monitorPositionKey));
  eq("no duplicate position keys", keys.size, merged.length);
}

section("store merge — live refresh, new add, close reconcile");
{
  const parts = [parseMonitorText(PART1), parseMonitorText(PART2), parseMonitorText(PART3)];
  const positions = mergeMonitorParts(parts);
  // first drop into an empty book
  let r = mergeMonitorIntoBook([], positions, "2026-06-19");
  assert("first drop adds positions", r.added === positions.length && r.updated === 0, `${r.added}/${r.updated}`);
  assert("all new positions flagged needsStatic", r.book.every((b) => b.needsStatic), "");
  const euRow = r.book.find((b) => b.symbol === "/6EU6");
  near("/6EU6 live P/L stored", euRow.pl_open, -910.95);
  assert("date_opened derived from days_open", euRow.date_opened === "2026-06-17", euRow.date_opened);

  // second drop: same positions, updated P/L, GLD dropped off
  const positions2 = positions.filter((p) => p.symbol !== "GLD")
    .map((p) => ({ ...p, pl_open: (p.pl_open || 0) + 100 }));
  const r2 = mergeMonitorIntoBook(r.book, positions2, "2026-06-26");
  assert("second drop updates in place (no dupes)", r2.added === 0, `added ${r2.added}`);
  near("/6EU6 P/L refreshed", r2.book.find((b) => b.symbol === "/6EU6").pl_open, -810.95);
  const closed = reconcileClosed(r2.book, r2.seenKeys);
  eq("GLD reconciled closed", closed, 1);
  eq("active book drops GLD", activeBook(r2.book).some((b) => b.symbol === "GLD"), false);
}

section("ticket/Curve static capture (Type C → NOW)");
{
  const NOW_CURVE = `NOW ServiceNow Inc 24h IV Rank 64.9 Last 105.13
Covered Short Call
BUY 1C 120 Call 8/21 (67d) 7.20
SELL -1C 130 Call 7/17 (32d) 1.55
POP -- EXT -560 P50 >99.5% Delta 22.36 Theta -1.117 Vega 9.61 CVaR -146.49 Max Profit 0 Max Loss 0 BP Eff. 555.00 db`;
  const tk = parseCurveText(NOW_CURVE);
  eq("symbol NOW", tk.symbol, "NOW");
  near("Max Profit = 0 (NOT Unlimited)", tk.max_profit, 0);
  near("Max Loss = 0 (NOT Unlimited)", tk.max_loss, 0);
  near("BP $", tk.bp_usd, 555);
  eq("two legs parsed", tk.legs.length, 2);

  // apply to a matching open position
  const book = [bookRowFromMonitor({ symbol: "NOW", strategy: "Custom", legs: [{ strike: 130, right: "C", expiry: "Jul 17" }], pl_open: -255 }, "2026-06-19")];
  const ap = applyTicketToBook(book, tk, "2026-06-19");
  assert("ticket attaches to NOW position", ap.matched, "");
  near("static Max Loss applied", book[0].max_loss, 0);
  near("static BP applied", book[0].bp_usd, 555);
  eq("needsStatic cleared", book[0].needsStatic, false);
}

section("parseInf — the $0 vs Unlimited fix");
{
  eq("'0' stays 0", parseInf("0"), 0);
  eq("'00' stays 0 (was Unlimited!)", parseInf("00"), 0);
  eq("'oo' is no longer infinity", parseInf("oo"), null); // 'oo' parses to no money
  eq("∞ glyph → inf", parseInf("∞"), "inf");
  eq("'Unlimited' word inf", parseInf("infinity"), "inf");
  near("real money still parses", parseInf("1,035"), 1035);
}

section("over-flagging fix — flag count on a CLEAN sheet");
{
  // simulate a clean 25-row x 6-money-col sheet: every cell VALID, Tesseract
  // conf in the realistic 55-69 band. Count flags under old vs new gate.
  const oldGate = (conf, v) => { if (!v.ok) return v.severity || "must"; if (conf >= 70) return null; if (conf >= 40) return "check"; return "must"; };
  const cells = [];
  for (let i = 0; i < 25 * 6; i++) cells.push({ raw: "1035", parsed: 1035, conf: 55 + (i % 15) }); // 55..69
  let oldFlags = 0, newFlags = 0;
  for (const c of cells) {
    const v = validateCell("credit_rcvd", c.raw, c.parsed);
    const conf = cellConfidence(c.conf, v);
    if (oldGate(conf, v)) oldFlags++;
    if (severityFor(conf, v)) newFlags++;
  }
  console.log(`  INFO  clean-sheet flags: old gate=${oldFlags}/${cells.length}, new gate=${newFlags}/${cells.length}`);
  assert("old gate over-flagged (>100)", oldFlags > 100, `${oldFlags}`);
  eq("new gate flags ~none on a clean sheet", newFlags, 0);
  // a genuine validator FAIL still flags under the new gate
  const bad = validateCell("credit_rcvd", "1.250", 1.25);
  assert("comma-misread still flagged", !!severityFor(cellConfidence(95, bad), bad), "");
  // a genuinely illegible valid cell (<38) still flags
  assert("very-low-conf valid still flagged", !!severityFor(cellConfidence(30, validateCell("credit_rcvd", "1035", 1035)), validateCell("credit_rcvd", "1035", 1035)), "");
}

section("reconciliation — FULL record Track Record");
{
  const m = computeTrackRecord(SEED.trades, { enabled: false });
  eq("88 closed trades", m.n, 88);
  near("realized total +$33,520.37", m.grossTotal, 33520.37, 0.01);
  near("win rate 81.8%", m.winRate, 81.8, 0.05);
  near("profit factor 6.67", m.profitFactor, 6.67, 0.01);
  eq("12 open positions in the live book", SEED.openBook.length, 12);
  // honest range label, not all-time
  eq("range covers Feb-Jun 2026", rangeLabel(m.firstDate, m.lastDate, m.n), "Feb–Jun 2026 · 18 weeks · 88 trades");
}

section("Core/Supp smart default + strategy vocab + adjustment outcome");
{
  eq("futures → Core", derivePositionType("/ESU6"), "Core");
  eq("GLD metals ETF → Core", derivePositionType("GLD"), "Core");
  eq("SPX index → Core", derivePositionType("SPX 7/17 Put Butterfly"), "Core");
  eq("plain equity → Supp (user promotes)", derivePositionType("AVGO"), "Supp");
  // Super Bull carries a naked short put → Undefined (NOT Defined)
  eq("Super Bull → Undef", deriveRiskType("AVGO 7/17 Super Bull"), "Undef");
  // Zebra kept; new vocab classified
  eq("Zebra → Def", deriveRiskType("ONDS Call Zebra"), "Def");
  eq("Risk-Free Fly → Def (zero-cost lock-in)", deriveRiskType("SPX Risk-Free Fly"), "Def");
  eq("Risk-Free Fly is an adjustment outcome", isAdjustmentOutcome("Risk-Free Fly"), true);
  eq("PMCC / Poor Man's = defined diagonal", deriveRiskType("AAPL Poor Man's Covered Call"), "Def");
  eq("Iron Fly → Def", deriveRiskType("SPX Iron Fly"), "Def");
}

section("regression — spreadsheet import is back-fill (does not wipe live)");
{
  const live = [bookRowFromMonitor({ symbol: "/6EU6", strategy: "Futures Option w/ a roll", legs: [{ strike: 1.155, right: "P", expiry: "Aug 7" }], pl_open: -910.95 }, "2026-06-19")];
  const imp = importSpreadsheetIntoBook(live, [
    { trade_description: "/6EU6 8/7 Short Put", credit_rcvd: 575, max_loss: 143800, bp_usd: 2280, date_opened: "2026-05-28" },
    { trade_description: "INTC strangle", credit_rcvd: 200, max_loss: 5000, bp_usd: 800, date_opened: "2026-05-01" },
  ]);
  assert("live /6EU6 enriched, not duplicated", imp.book.filter((b) => b.symbol === "/6EU6").length === 1, "");
  near("/6EU6 static credit back-filled onto live row", imp.book.find((b) => b.symbol === "/6EU6").credit_rcvd, 575);
  assert("new history row appended", imp.book.some((b) => /INTC/i.test(b.trade_description || "")), "");
}

console.log(`\n${failed ? "✗" : "✓"} repoint: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
