// validators.js — per-column validators. Pure, testable.
// confidence = min(OCR per-word confidence, validator pass ? 100 : 0).
// These catch the DANGEROUS high-confidence misreads (clean-looking "1.250"
// that should be "1,250") that raw OCR confidence alone would wave through.

const TICKER_RE = /^\/?[A-Z0-9.\-]{1,6}$/;
const DATE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})$/;
const MONEY_COLS = new Set(["credit_rcvd", "debit_paid", "max_profit", "max_loss", "bp_usd", "total_pl"]);

// Returns { ok, suggested, msg, severity }  severity: "must" | "check" | null
export function validateCell(column, rawText, parsedValue) {
  const raw = (rawText == null ? "" : String(rawText)).trim();

  if (column === "trade_description") {
    if (!raw) return fail("empty description", "must");
    if (raw.length < 2) return check("very short — confirm", raw);
    return ok();
  }

  if (MONEY_COLS.has(column)) {
    if (parsedValue === "inf") return ok(); // ∞ handled by rule, not OCR
    if (raw === "" || raw === "-") {
      // blank is legitimate for credit XOR debit; not an error
      return ok();
    }
    // contains letters → misread
    if (/[a-z]/i.test(raw) && !/inf/i.test(raw)) return fail(`non-numeric "${raw}"`, "must");
    // DANGEROUS: a 3-decimal value in a whole-dollar column is almost always a
    // comma read as a period: 1,250 -> 1.250. Suggest ×1000.
    const m = raw.replace(/,/g, "").match(/^(-?)(\d+)\.(\d{3})$/);
    if (m) {
      const sus = parseFloat(raw.replace(/,/g, "")) * 1000;
      return { ok: false, suggested: Math.round(sus), msg: `"${raw}" looks like a comma misread → ${Math.round(sus).toLocaleString()}?`, severity: "must" };
    }
    if (parsedValue === null) return fail(`couldn't parse "${raw}"`, "must");
    return ok();
  }

  if (column === "bp_pct") {
    if (raw === "") return ok();
    const n = parseFloat(raw.replace(/[%,]/g, ""));
    if (!Number.isFinite(n)) return fail(`not a percent: "${raw}"`, "check");
    if (n < 0 || n > 100) return check(`% out of range (${n})`, String(Math.min(Math.max(n, 0), 100)));
    return ok();
  }

  if (column === "position_type") {
    const v = norm(raw);
    if (!v) return ok();
    if (v === "Core" || v === "Supp") return ok();
    const snap = snapTo(v, ["Core", "Supp"]);
    return { ok: false, suggested: snap, msg: `"${raw}" not Core/Supp${snap ? ` → ${snap}?` : ""}`, severity: "check" };
  }

  if (column === "risk_type") {
    const v = norm(raw);
    if (!v) return ok();
    if (v === "Def" || v === "Undef") return ok();
    const snap = snapTo(v, ["Def", "Undef"]);
    return { ok: false, suggested: snap, msg: `"${raw}" not Def/Undef${snap ? ` → ${snap}?` : ""}`, severity: "check" };
  }

  if (column === "date_opened") {
    if (!raw) return ok();
    if (DATE_RE.test(raw)) return ok();
    return check(`date format "${raw}"`, raw);
  }

  if (column === "ticker") {
    if (!raw) return fail("no ticker (may be cropped off)", "must");
    const up = raw.toUpperCase();
    if (TICKER_RE.test(up)) return ok();
    const cleaned = up.replace(/[^A-Z0-9./\-]/g, "");
    return { ok: false, suggested: cleaned || null, msg: `odd ticker "${raw}"`, severity: "check" };
  }

  return ok();
}

// Cross-foot validators on the portfolio summary (free correctness checks).
// Core+Supp ≈ 100, Undef+Def ≈ 100.
export function crossFootSummary(pm) {
  const out = [];
  if (pm.core_pct != null && pm.supplemental_pct != null) {
    const s = Number(pm.core_pct) + Number(pm.supplemental_pct);
    if (Math.abs(s - 100) > 2) out.push(`Mix Core+Supp = ${s}% (expected ~100)`);
  }
  if (pm.undefined_pct != null && pm.defined_pct != null) {
    const s = Number(pm.undefined_pct) + Number(pm.defined_pct);
    if (Math.abs(s - 100) > 2) out.push(`Risk Undef+Def = ${s}% (expected ~100)`);
  }
  return out;
}

export function cellConfidence(ocrConf, validation) {
  const passConf = validation.ok ? 100 : 0;
  return Math.min(Number.isFinite(ocrConf) ? ocrConf : 0, passConf);
}

// confidence → severity bucket.
// TRUST THE VALIDATOR. A cell that passes its column validator is structurally
// correct (right shape, in range, cross-foots). Tesseract routinely reports
// per-cell confidence of 55-69 on small, valid grid text, so gating auto-accept
// at the old conf>=70 flagged the majority of a CLEAN sheet (~65%) — the exact
// opposite of the "confirm a few" promise. So: when validation.ok, auto-accept
// at a much lower OCR-conf gate (>=50); reserve flags for validator FAILS or
// genuinely low confidence (<~38, where the glyphs themselves are unreliable).
export function severityFor(conf, validation) {
  if (!validation.ok) return validation.severity || "must";
  if (conf >= 50) return null;        // valid + legible → auto-accept (green)
  if (conf >= 38) return "check";     // valid but faint → 🟡 quick look
  return "must";                      // valid yet barely legible → 🔴 confirm
}

// --- helpers ---
function ok() { return { ok: true, suggested: null, msg: "", severity: null }; }
function fail(msg, sev) { return { ok: false, suggested: null, msg, severity: sev || "check" }; }
function check(msg, suggested) { return { ok: false, suggested: suggested ?? null, msg, severity: "check" }; }
function norm(v) {
  if (/^core/i.test(v)) return "Core";
  if (/^supp/i.test(v)) return "Supp";
  if (/^undef/i.test(v)) return "Undef";
  if (/^def/i.test(v)) return "Def";
  return v;
}
function snapTo(v, set) {
  const lo = v.toLowerCase();
  for (const s of set) if (s.toLowerCase().startsWith(lo.slice(0, 2))) return s;
  return null;
}
