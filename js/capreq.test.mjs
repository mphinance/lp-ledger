// capreq.test.mjs — headless validation for the tastytrade Capital Requirement
// CSV import (Ryan's request: import BP Usage from the Capital Requirement CSV).
// Run: node js/capreq.test.mjs
//
// No real export file is in the repo, so we test against header variants that
// tastytrade has shipped (the report exposes Requirement / Buying Power Effect,
// BP Usage %, Initial Requirement, Maintenance Requirement) plus the tolerant
// edges: preamble lines, $/comma/paren formatting, a Total row, and the
// per-underlying → open-book attribution (unique match fills, ambiguous skips).

import { parseCsvText, parseMoney, parseCapitalRequirementCsv } from "./csv.js";
import { applyCapReqToBook } from "./store.js";

let passed = 0, failed = 0;
function assert(label, cond, detail = "") {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`); failed++; }
}
function eq(label, got, want) { assert(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
function near(label, got, want, tol = 0.01) { assert(label, got != null && Math.abs(got - want) <= tol, `got ${got} want ${want}`); }
function section(n) { console.log(`\n== ${n} ==`); }

// --- raw CSV reader ---------------------------------------------------------
section("parseCsvText");
{
  const rows = parseCsvText('a,b,c\r\n1,"2,3",4\n"he said ""hi""",x,y');
  eq("row count", rows.length, 3);
  eq("quoted comma stays one field", rows[1][1], "2,3");
  eq("escaped quote", rows[2][0], 'he said "hi"');
}

// --- number parsing ---------------------------------------------------------
section("parseMoney");
{
  near("dollars + commas", parseMoney("$4,172.75"), 4172.75);
  near("parens = negative", parseMoney("($1,990.00)"), -1990);
  near("leading minus", parseMoney("-1,990.00"), -1990);
  near("percent strips %", parseMoney("8.7%"), 8.7);
  eq("blank → null", parseMoney(""), null);
  eq("dash → null", parseMoney("--"), null);
  eq("N/A → null", parseMoney("N/A"), null);
}

// --- the real-shape header (Requirement = Buying Power Effect, negative) -----
section("parseCapitalRequirementCsv — canonical header");
{
  const csv = [
    "Symbol,Requirement,BP Usage %,Initial Requirement,Maintenance Requirement",
    "SPY,\"-$4,172.75\",8.7%,\"$4,172.75\",\"$4,172.75\"",
    "/ES,\"($1,990.00)\",4.1%,\"$1,990.00\",\"$1,990.00\"",
    "AAPL,-910.95,1.9%,910.95,910.95",
    "Total,\"-$7,073.70\",14.7%,,",
  ].join("\n");
  const res = parseCapitalRequirementCsv(csv);
  eq("ok", res.ok, true);
  eq("3 position rows (Total excluded)", res.rows.length, 3);
  eq("symbol normalized w/ slash", res.rows[1].symbol, "/ES");
  near("BP $ is positive (abs of Buying Power Effect)", res.rows[0].bp_usd, 4172.75);
  near("BP %", res.rows[0].bp_pct, 8.7);
  near("total BP $ from Total row", res.total.bp_usd, 7073.70);
  near("total BP % from Total row", res.total.bp_pct, 14.7);
}

// --- header variant: "Underlying", no Total row, only maintenance for BP -----
section("parseCapitalRequirementCsv — Underlying header, no explicit BP col");
{
  const csv = [
    "Underlying Symbol,Initial Requirement,Maintenance Requirement,BP Usage %",
    "MES,500.00,250.00,1.2%",
    "SPX,12000.00,9000.00,30.0%",
  ].join("\n");
  const res = parseCapitalRequirementCsv(csv);
  eq("ok", res.ok, true);
  near("falls back to maintenance for BP $", res.rows[0].bp_usd, 250);
  near("summed total BP % (no Total row)", res.total.bp_pct, 31.2);
  near("summed total BP $", res.total.bp_usd, 9250);
}

// --- preamble lines before the header are skipped ---------------------------
section("parseCapitalRequirementCsv — title preamble");
{
  const csv = [
    "Capital Requirements Report",
    "Account: 5WX12345,Generated 2026-06-28",
    "",
    "Symbol,Buying Power Effect,BP Usage %",
    "SPY,-4172.75,8.7%",
  ].join("\n");
  const res = parseCapitalRequirementCsv(csv);
  eq("ok despite preamble", res.ok, true);
  eq("header located after preamble (blank rows pre-filtered)", res.headerIdx, 2);
  eq("one row", res.rows.length, 1);
}

// --- rejects a non-capreq CSV ----------------------------------------------
section("rejection");
{
  const res = parseCapitalRequirementCsv("Date,Action,Symbol,Price\n2026-01-01,BTO,SPY,400");
  eq("not ok", res.ok, false);
  assert("has reason", typeof res.reason === "string" && res.reason.length > 0);
}

// --- applyCapReqToBook: unique match fills, ambiguous → summary only --------
section("applyCapReqToBook");
{
  const book = [
    { id: "a", symbol: "SPY", trade_description: "SPY iron condor", bp_usd: null, bp_pct: null, closed: false },
    { id: "b", symbol: "MES", trade_description: "MES strangle", bp_usd: null, bp_pct: null, closed: false },
    { id: "c", symbol: "MES", trade_description: "MES put spread", bp_usd: null, bp_pct: null, closed: false },
    { id: "d", symbol: "TSLA", trade_description: "TSLA put", bp_usd: null, bp_pct: null, closed: false, static_source: "ticket" },
  ];
  const capReq = { rows: [
    { symbol: "SPY", bp_usd: 4172.75, bp_pct: 8.7 },   // unique → fills
    { symbol: "MES", bp_usd: 500, bp_pct: 1.2 },        // two MES rows → ambiguous
    { symbol: "QQQ", bp_usd: 900, bp_pct: 2.0 },        // not in book → unmatched
    { symbol: "TSLA", bp_usd: 1200, bp_pct: 3.0 },      // unique, keeps ticket static_source
  ] };
  const r = applyCapReqToBook(book, capReq, "2026-06-28");
  eq("filled count", r.filled, 2);
  eq("ambiguous count (MES x2)", r.ambiguous, 1);
  eq("unmatched count (QQQ)", r.unmatched.length, 1);
  near("SPY bp_usd filled", book[0].bp_usd, 4172.75);
  eq("SPY static_source set to capreq", book[0].static_source, "capreq");
  eq("MES rows untouched (ambiguous)", book[1].bp_usd, null);
  near("TSLA bp_usd filled", book[3].bp_usd, 1200);
  eq("TSLA keeps original static_source", book[3].static_source, "ticket");
  eq("TSLA bp_source tagged", book[3].bp_source, "capreq");
}

// --- summary ----------------------------------------------------------------
console.log(`\n${failed ? "✗" : "✓"} capreq: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
