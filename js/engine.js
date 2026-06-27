// engine.js — realized-PnL + track-record stats.
// Ported (semantics frozen) from the borrowed TS journal engine
//   - stats.ts::winRate / sumPnl / group-aggregate
//   - rowMapper.ts::numOrNull / strOrNull (tolerant OCR coercion)
// plus the equity-curve / avg-win-loss / profit-factor recipe from INTEGRATION_BRIEF.md.
// The seed now reconciles to the FULL record: +$33,520.37 over 88 closed trades
// (Feb-Jun 2026, 18 weeks); win rate 81.8%, profit factor 6.67.

// --- tolerant coercion (OCR + Postgres-string safe) -------------------------
export function numOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\$/g, "").replace(/,/g, "");
  if (s === "" || s === "-" || s === "—") return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
  const x = parseFloat(s);
  if (!Number.isFinite(x)) return null;
  return neg ? -Math.abs(x) : x;
}

export function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// --- fee model (default no-op) ---------------------------------------------
// legCount is # of contract-legs traded (open + close). Off by default.
export function applyFees(grossPnl, legCount, fees) {
  if (!fees || !fees.enabled) return grossPnl;
  const per = (fees.perContractOpen || 0) + (fees.perContractClose || 0) + (fees.clearingReg || 0);
  return grossPnl - per * (legCount || 1);
}

// --- track record over a list of CLOSED trade records {pl, strategy, ticker, date_closed} ---
export function computeTrackRecord(closedTrades, fees) {
  const closed = closedTrades
    .filter((t) => numOrNull(t.pl) !== null)
    .map((t) => {
      const gross = numOrNull(t.pl);
      const net = applyFees(gross, t.legCount || 2, fees);
      return { ...t, gross, plNet: net };
    })
    .sort((a, b) => String(a.date_closed || "9999").localeCompare(String(b.date_closed || "9999")));

  const useNet = !!(fees && fees.enabled);
  const val = (t) => (useNet ? t.plNet : t.gross);

  const pls = closed.map(val);
  const wins = pls.filter((p) => p > 0);
  const losses = pls.filter((p) => p < 0);
  const grossWin = round2(sum(wins));
  const grossLoss = round2(sum(losses));
  const n = pls.length;

  // equity curve: cumulative by close date (realized booked at exit)
  let run = 0;
  const equity = closed.map((t) => {
    run += val(t);
    return { date: t.date_closed, equity: round2(run), ticker: t.ticker, pl: round2(val(t)) };
  });

  // per-strategy aggregation (group → {count, winRate, total})
  const stratMap = new Map();
  for (const t of closed) {
    const k = t.strategy || "Uncategorized";
    const s = stratMap.get(k) || { strategy: k, count: 0, wins: 0, total: 0 };
    s.count += 1;
    if (val(t) > 0) s.wins += 1;
    s.total += val(t);
    stratMap.set(k, s);
  }
  const strategies = [...stratMap.values()]
    .map((s) => ({ ...s, total: round2(s.total), winRate: s.count ? round1((100 * s.wins) / s.count) : 0 }))
    .sort((a, b) => b.total - a.total);

  const best = closed.length ? closed.reduce((a, b) => (val(b) > val(a) ? b : a)) : null;
  const worst = closed.length ? closed.reduce((a, b) => (val(b) < val(a) ? b : a)) : null;

  return {
    total: round2(sum(pls)),
    grossTotal: round2(sum(closed.map((t) => t.gross))),
    n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? round1((100 * wins.length) / n) : null,
    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : null,
    grossWin,
    grossLoss,
    profitFactor: grossLoss !== 0 ? round2(grossWin / -grossLoss) : null,
    expectancy: n ? round2(sum(pls) / n) : null,
    equity,
    strategies,
    best: best ? { pl: round2(val(best)), ticker: best.ticker } : null,
    worst: worst ? { pl: round2(val(worst)), ticker: worst.ticker } : null,
    firstDate: closed.length ? closed[0].date_closed : "",
    lastDate: closed.length ? closed[closed.length - 1].date_closed : "",
    trades: closed,
    useNet,
  };
}

// --- portfolio summary from the open book (derives mix if not supplied) ------
export function deriveBookSummary(openBook) {
  // crude mix derivation as a cross-check when no summary card is OCR'd.
  let core = 0, supp = 0, undef = 0, def = 0, bp = 0;
  for (const o of openBook) {
    const w = numOrNull(o.bp_usd) || 0;
    bp += w;
    if (/^core/i.test(o.position_type || "")) core += w; else if (/^supp/i.test(o.position_type || "")) supp += w;
    if (/^undef/i.test(o.risk_type || "")) undef += w; else if (/^def/i.test(o.risk_type || "")) def += w;
  }
  const pct = (a, b) => (a + b ? round1((100 * a) / (a + b)) : null);
  return {
    totalBp: round2(bp),
    core_pct: pct(core, supp),
    supplemental_pct: pct(supp, core),
    undefined_pct: pct(undef, def),
    defined_pct: pct(def, undef),
  };
}

// --- helpers ----------------------------------------------------------------
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round1(n) { return Math.round((n + Number.EPSILON) * 10) / 10; }

// --- risk-type auto-derivation (matches Ryan's own sheet; "max loss known at
// entry = Defined") -----------------------------------------------------------
// Strategy vocab from his book. Risk-Free Fly is an adjustment OUTCOME (a BWB
// converted to zero cost basis) — locked-in premium, no remaining downside → Def.
// Super Bull is a short put financing a call debit spread → carries a naked
// short put → Undef (it lives in UNDEFINED_HINTS, NOT DEFINED_HINTS).
const DEFINED_HINTS = [
  "spread", "butterfly", "iron fly", "iron butterfly", "fly", "condor",
  "zebra", "diagonal", "poor man", "covered", "long call", "long put",
  "leaps", "calendar", "risk-free fly",
];
const UNDEFINED_HINTS = ["short put", "short call", "strangle", "straddle", "super bull"];

// Strategies that are an adjustment OUTCOME / zero-cost-basis lock-in rather
// than a normal entry. They still realize P/L (and count in the track record),
// but they carry no remaining risk — treat as Defined, never as a naked entry.
export const ADJUSTMENT_STRATEGIES = ["Risk-Free Fly"];
export function isAdjustmentOutcome(strategy) {
  return ADJUSTMENT_STRATEGIES.some((s) => (strategy || "").toLowerCase() === s.toLowerCase());
}

export function deriveRiskType(description) {
  if (!description) return null;
  const d = description.toLowerCase();
  // long futures / stock (no premium cap) → undefined
  if (/\/\w+.*\blong\b/.test(d) && !d.includes("call") && !d.includes("put")) return "Undef";
  const hasNaked = UNDEFINED_HINTS.some((h) => d.includes(h)) && !d.includes("spread");
  const hasDefined = DEFINED_HINTS.some((h) => d.includes(h));
  if (hasNaked && !hasDefined) return "Undef";
  if (hasDefined && !hasNaked) return "Def";
  if (hasNaked && hasDefined) return "Undef"; // mixed w/ a naked short leg (e.g. Super Bull)
  return null;
}

// --- Core/Supp smart default (his portfolio-building definition) -------------
// Core = futures (symbols starting "/"), index options, metals ETFs (GLD/SLV),
// and stocks he wants to own; everything else = Supp. Default the tag this way;
// it stays user-editable. (The "stocks he wants to own" set is discretionary, so
// the algorithmic default puts plain equities in Supp for the user to promote.)
const INDEX_TICKERS = new Set(["SPX", "SPY", "QQQ", "NDX", "RUT", "XSP", "VIX", "DIA", "IWM"]);
const METALS_ETFS = new Set(["GLD", "SLV"]);

export function derivePositionType(symbolOrDesc) {
  const raw = String(symbolOrDesc || "").trim().toUpperCase();
  if (!raw) return "Supp";
  if (raw.startsWith("/")) return "Core";                 // futures
  const sym = (raw.match(/^[A-Z]{1,6}/) || [""])[0];
  if (INDEX_TICKERS.has(sym)) return "Core";              // index options
  if (METALS_ETFS.has(sym)) return "Core";                // metals ETFs
  return "Supp";                                          // discretionary; user promotes
}

// --- honest range label for the Track Record panel + Weekly Card ------------
// e.g. "Feb-Jun 2026 · 18 weeks · 88 trades" — never reads as all-time.
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function rangeLabel(firstDate, lastDate, n) {
  if (!firstDate || !lastDate) return n ? `${n} trades` : "";
  const a = new Date(firstDate + "T00:00:00Z"), b = new Date(lastDate + "T00:00:00Z");
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return n ? `${n} trades` : "";
  const mA = MONTHS_ABBR[a.getUTCMonth()], mB = MONTHS_ABBR[b.getUTCMonth()];
  const yA = a.getUTCFullYear(), yB = b.getUTCFullYear();
  const months = mA === mB && yA === yB ? `${mA} ${yB}` : (yA === yB ? `${mA}–${mB} ${yB}` : `${mA} ${yA}–${mB} ${yB}`);
  const weeks = Math.max(1, Math.ceil((b - a) / (7 * 864e5)));
  return `${months} · ${weeks} weeks · ${n} trades`;
}
