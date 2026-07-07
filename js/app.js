// app.js — orchestrator: state, persistence, panels, OCR ingest, editing.
import { SEED } from "./seed.js";
import { computeTrackRecord, deriveBookSummary, deriveRiskType, rangeLabel } from "./engine.js";
import { drawEquityCurve, drawStrategyBars, gaugeHtml, drawDonut, money, moneyInt } from "./charts.js";
import { processScreenshot, mergeMonitorParts, forgetImages, cropToDataUrl } from "./ocr.js";
import { mergeMonitorIntoBook, reconcileClosed, applyTicketToBook, importSpreadsheetIntoBook, applyCapReqToBook, activeBook } from "./store.js";
import { parseCapitalRequirementCsv } from "./csv.js";
import { renderQueue, pending as reviewPending, counts as reviewCounts } from "./review.js";
import { renderCardCanvas, copyCanvasToClipboard, downloadCanvas } from "./card.js";
import { exportJson, parseImport, readFileText, shouldNudge, daysSinceBackup } from "./backup.js";
import { validateCell, cellConfidence, severityFor } from "./validators.js";
import { PROVIDERS, DEFAULT_PROVIDER, getProvider, getKey, setKey, readCropWithVision } from "./vision.js";
import { ACTIVE_BRAND, getBrand, applyBrand } from "./brand.js";

const LS_KEY = "tt-tracker-state-v2";
const POS = "#27c19a", NEG = "#f6465c", GOLD = "#ffcb05", BLUE = "#4a90e2", VIOLET = "#9b6bff";

// --- state ------------------------------------------------------------------
let state = load();

function defaults() {
  return {
    trades: structuredClone(SEED.trades),
    openBook: structuredClone(SEED.openBook),
    summary: structuredClone(SEED.summary),
    monitor: [],
    pendingTickets: [], // static captures awaiting a matching position
    review: [],
    fees: { enabled: false, perContractOpen: 1.0, perContractClose: 0, clearingReg: 0.15 },
    cardPrefs: { handle: "@yourhandle", showDollars: false, weekEnding: "" },
    // BYOK vision config (NEVER the key — that lives in sessionStorage only).
    vision: { enabled: false, provider: DEFAULT_PROVIDER, model: "", baseUrl: "" },
  };
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaults();
    const s = JSON.parse(raw);
    return { ...defaults(), ...s };
  } catch { return defaults(); }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { console.warn("persist failed", e); }
}
function resetSeed() {
  if (!confirm("Reset everything back to Ryan's verified seed data? Your edits and OCR'd rows will be cleared.")) return;
  state = defaults(); forgetImages(); save(); renderAll();
}

// --- tabs -------------------------------------------------------------------
function initTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("panel-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "track") renderTrack();
    if (t.dataset.tab === "import") { renderStaging(); refreshReviewUI(); }
    if (t.dataset.tab === "share") renderShare();
  }));
}

function goToTab(name) {
  const t = document.querySelector(`.tab[data-tab="${name}"]`);
  if (t) t.click();
}

// --- TRACK RECORD panel -----------------------------------------------------
function renderTrack() {
  const m = computeTrackRecord(state.trades, state.fees);
  const grid = document.getElementById("kpis");
  // Reconciles to the FULL verified record: +$33,520.37 over 88 closed trades.
  const matches = Math.abs(m.grossTotal - 33520.37) < 0.5 && m.n === 88;
  const range = rangeLabel(m.firstDate, m.lastDate, m.n);
  grid.innerHTML = [
    kpi("Realized P/L", money(state.fees.enabled ? m.total : m.grossTotal, true), m.total >= 0 ? "pos" : "neg", state.fees.enabled ? "net of fees" : "gross"),
    kpi("Win Rate", m.winRate != null ? m.winRate + "%" : "—", "", `${m.wins}W · ${m.losses}L`),
    kpi("Profit Factor", m.profitFactor != null ? m.profitFactor.toFixed(2) : "—", "gold", "gross win ÷ gross loss"),
    kpi("Closed Trades", m.n, "", range || `${m.firstDate} → ${m.lastDate}`),
    kpi("Avg Win", money(m.avgWin), "pos"),
    kpi("Avg Loss", money(m.avgLoss), "neg"),
    kpi("Best", m.best ? glyphMoney(m.best.pl) : "—", "pos", m.best ? m.best.ticker : ""),
    kpi("Worst", m.worst ? glyphMoney(m.worst.pl) : "—", "neg", m.worst ? m.worst.ticker : ""),
  ].join("");

  // Honest range label — never reads as all-time. Shows even when reconciled.
  const rangeTag = range ? `<span class="rangelbl" title="track-record window">${range}</span>` : "";
  document.getElementById("seed-check").innerHTML = (matches
    ? `<span class="ok">✓ reconciles to verified sample</span> +$33,520.37 · ${m.winRate}% · ${m.profitFactor.toFixed(2)} PF`
    : `<span class="warn">edited</span> realized now ${money(m.grossTotal, true)}`) + rangeTag;

  // equity curve
  const tipBox = document.getElementById("eq-tip");
  drawEquityCurve(document.getElementById("equity"), m.equity, (p, e) => {
    if (!p) { tipBox.style.opacity = 0; return; }
    tipBox.style.opacity = 1;
    tipBox.innerHTML = `<b>${p.ticker}</b> ${money(p.pl, true)}<span>equity ${money(p.equity)} · ${p.date}</span>`;
    const r = document.getElementById("equity").getBoundingClientRect();
    tipBox.style.left = Math.min(e.clientX - r.left + 14, r.width - 150) + "px";
  });

  drawStrategyBars(document.getElementById("stratbars"), m.strategies);

  // closed trades table
  const tb = document.querySelector("#trades-table tbody");
  const rows = [...m.trades].sort((a, b) => String(b.date_closed).localeCompare(String(a.date_closed)));
  tb.innerHTML = rows.map((t) => {
    const v = state.fees.enabled ? t.plNet : t.gross;
    return `<tr>
      <td class="mono">${t.date_closed}</td>
      <td class="mono">${t.date_opened || "—"}</td>
      <td class="tk">${t.ticker}</td>
      <td>${t.strategy}</td>
      <td>${t.type ? `<span class="chip ${t.type}">${t.type}</span>` : ""}</td>
      <td class="mono r ${v >= 0 ? "pos" : "neg"}">${glyphMoney(v)}</td>
      <td class="note">${escapeHtml(t.notes || "")}</td>
    </tr>`;
  }).join("");
  document.getElementById("trades-count").textContent = m.n;
}

function kpi(label, val, cls = "", sub = "") {
  return `<div class="kpi"><div class="kpi-v ${cls}">${val}</div><div class="kpi-l">${label}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ""}</div>`;
}

// Colorblind aid: a sign/arrow glyph so gain vs loss reads WITHOUT color.
// ▲ gain · ▼ loss · = flat. Paired with the existing +/- in money().
function signGlyph(v) {
  if (v == null || Number.isNaN(v)) return "";
  return v > 0 ? "▲" : v < 0 ? "▼" : "=";
}
function glyphMoney(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const g = signGlyph(v);
  return `<span class="glyph" aria-hidden="true">${g}</span> ${money(v, true)}`;
}

// --- LIVE BOOK panel --------------------------------------------------------
function renderBook() {
  const tb = document.querySelector("#book-table tbody");
  // render the ACTIVE book (closed positions drop off), but keep data-i pointing
  // at the real index in state.openBook so inline edits target the right row.
  const rows = state.openBook.map((o, i) => [o, i]).filter(([o]) => !o.closed);
  tb.innerHTML = rows.map(([o, i]) => bookRow(o, i)).join("");
  document.getElementById("book-count").textContent = rows.length;

  // wire editable cells
  tb.querySelectorAll("[data-edit]").forEach((cell) => {
    cell.addEventListener("blur", () => commitBookEdit(cell));
    cell.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); cell.blur(); } });
  });
  tb.querySelectorAll("select[data-field]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const i = +sel.closest("tr").dataset.i;
      state.openBook[i][sel.dataset.field] = sel.value;
      save(); renderSummary();
    });
  });

  renderSummary();
}

function bookRow(o, i) {
  const cls = [o.needsReview ? "review" : "", o.needsStatic ? "needstatic" : ""].filter(Boolean).join(" ");
  const riskDerived = o.risk_type_source === "derived";
  const liveTip = o.pl_open != null ? ` title="live P/L Open ${money(o.pl_open, true)}${o.pl_open_pct != null ? ` (${o.pl_open_pct}%)` : ""} · mark ${o.mark ?? "—"} · ${o.dte != null ? o.dte + "d to exp" : ""}"` : "";
  const needsTag = o.needsStatic ? ` <span class="needs" title="open the order ticket / Curve once to capture Max P/L, BP and credit/debit">⊕ ticket</span>` : "";
  return `<tr data-i="${i}" class="${cls}"${liveTip}>
    <td class="desc" data-edit data-field="trade_description" contenteditable="true">${escapeHtml(o.trade_description || "")}${needsTag}</td>
    <td class="mono r ${(o.pl_open ?? 0) >= 0 ? "pos" : "neg"}">${o.pl_open != null ? money(o.pl_open, true) : "<span class='dim'>—</span>"}</td>
    <td class="mono r pos" data-edit data-field="credit_rcvd" contenteditable="true">${moneyInt(o.credit_rcvd)}</td>
    <td class="mono r neg" data-edit data-field="debit_paid" contenteditable="true">${moneyInt(o.debit_paid)}</td>
    <td class="mono r" data-edit data-field="max_profit" contenteditable="true">${moneyInt(o.max_profit)}</td>
    <td class="mono r" data-edit data-field="max_loss" contenteditable="true">${moneyInt(o.max_loss)}</td>
    <td class="mono r" data-edit data-field="bp_usd" contenteditable="true">${moneyInt(o.bp_usd)}</td>
    <td class="mono r dim">${o.bp_pct != null ? o.bp_pct + "%" : ""}</td>
    <td>${selectCell(i, "position_type", o.position_type, [["Core", "Core"], ["Supp", "Supp"]])}</td>
    <td>${selectCell(i, "risk_type", o.risk_type, [["Def", "Def"], ["Undef", "Undef"]])}${riskDerived ? '<span class="der" title="auto-derived">·d</span>' : ""}</td>
    <td class="mono r dim">${o.date_opened || ""}</td>
  </tr>`;
}

function selectCell(i, field, val, opts) {
  const cls = field === "position_type" ? (val === "Core" ? "core" : "supp") : (val === "Undef" ? "undef" : "def");
  const o = opts.map(([v, l]) => `<option value="${v}" ${v === val ? "selected" : ""}>${l}</option>`).join("");
  return `<select class="pillsel ${cls}" data-field="${field}">${o}<option value="" ${!val ? "selected" : ""}>—</option></select>`;
}

function commitBookEdit(cell) {
  const i = +cell.closest("tr").dataset.i;
  const f = cell.dataset.field;
  let txt = cell.textContent.trim();
  const o = state.openBook[i];
  if (["credit_rcvd", "debit_paid", "max_profit", "max_loss", "bp_usd"].includes(f)) {
    if (txt === "∞") o[f] = "inf";
    else if (txt === "") o[f] = null;
    else o[f] = Number(txt.replace(/[,$]/g, "")) || null;
  } else {
    o[f] = txt;
    if (f === "trade_description" && !o.risk_type) {
      const d = deriveRiskType(txt);
      if (d) { o.risk_type = d; o.risk_type_source = "derived"; }
    }
  }
  // editing a cell inline also resolves any pending review item for it
  (state.review || []).forEach((it) => { if (it.rowId === o.id && it.field === f) { it.confirmed = true; it.value = o[f]; } });
  if (!(state.review || []).some((it) => it.rowId === o.id && !it.confirmed)) delete o.needsReview;
  save(); renderBook(); refreshReviewUI();
}

function renderSummary() {
  const s = state.summary || {};
  const pm = s.position_mix || {};
  const bp = s.buying_power || {};
  const derived = deriveBookSummary(activeBook(state.openBook));

  drawDonut(document.getElementById("mix-core"), [
    { pct: pm.core_pct ?? derived.core_pct ?? 0, color: BLUE },
    { pct: pm.supplemental_pct ?? derived.supplemental_pct ?? 0, color: VIOLET },
  ]);
  drawDonut(document.getElementById("mix-risk"), [
    { pct: pm.defined_pct ?? derived.defined_pct ?? 0, color: POS },
    { pct: pm.undefined_pct ?? derived.undefined_pct ?? 0, color: GOLD },
  ]);

  document.getElementById("mix-legend").innerHTML = `
    <div class="lg"><i style="background:${BLUE}"></i>Core ${fmtp(pm.core_pct ?? derived.core_pct)}</div>
    <div class="lg"><i style="background:${VIOLET}"></i>Supp ${fmtp(pm.supplemental_pct ?? derived.supplemental_pct)}</div>
    <div class="lg"><i style="background:${POS}"></i>Defined ${fmtp(pm.defined_pct ?? derived.defined_pct)}</div>
    <div class="lg"><i style="background:${GOLD}"></i>Undef ${fmtp(pm.undefined_pct ?? derived.undefined_pct)}</div>`;

  document.getElementById("bp-gauges").innerHTML =
    gaugeHtml("BP Target", bp.bp_target_pct, BLUE) +
    gaugeHtml("BP Usage", bp.bp_usage_pct, GOLD) +
    gaugeHtml("Trading Usage", bp.trading_usage_pct, VIOLET) +
    gaugeHtml("Stock Usage", bp.stock_usage_pct, BLUE) +
    `<div class="bp-foot">Total BP committed (book): <b>${money(derived.totalBp)}</b>` +
    (bp.bp_usage_usd != null ? ` · tasty Capital Req: <b>${money(bp.bp_usage_usd)}</b>${bp.bp_asof ? ` <span class="dim">(${bp.bp_asof})</span>` : ""}` : "") +
    `</div>`;
}
function fmtp(v) { return v != null ? v + "%" : "—"; }
function round1(n) { return n == null ? null : Math.round((n + Number.EPSILON) * 10) / 10; }

// --- MONITOR STAGING (on the Import panel) ----------------------------------
// The weekly-monitor slices you dropped, previewed and waiting for you to merge.
// This is the "eyeball it, then commit" checkpoint — now shown right where you
// dropped the files instead of hidden behind a separate tab.
function renderStaging() {
  const box = document.getElementById("import-staging");
  if (!box) return;
  if (!monitorParts.length) { box.hidden = true; box.innerHTML = ""; return; }
  // mergeMonitorParts is PURE — safe to run for a preview without touching state.
  const preview = mergeMonitorParts(monitorParts);
  const nParts = monitorParts.length;
  box.hidden = false;
  box.innerHTML = `
    <div class="card-h">
      <h2>Weekly monitor — ready to merge</h2>
      <span class="card-sub"><b>${nParts}</b> slice${nParts > 1 ? "s" : ""} · <b>${preview.length}</b> position${preview.length !== 1 ? "s" : ""} detected</span>
    </div>
    <div class="scroll">
      <table class="data"><thead><tr><th>Symbol</th><th>Strategy</th><th class="r">P/L Open</th><th class="r">Opn%</th><th class="r">Mark</th><th class="r">DTE</th></tr></thead>
      <tbody>${preview.map((p) => `<tr>
        <td class="tk">${escapeHtml(p.symbol || "?")}${p.legs && p.legs.length ? ` <span class="dim">·${p.legs.length}L</span>` : ""}</td>
        <td>${escapeHtml(p.strategy || "")}</td>
        <td class="mono r ${(p.pl_open ?? 0) >= 0 ? "pos" : "neg"}">${p.pl_open != null ? money(p.pl_open, true) : "—"}</td>
        <td class="mono r dim">${p.pl_open_pct != null ? p.pl_open_pct + "%" : ""}</td>
        <td class="mono r dim">${p.mark ?? ""}</td>
        <td class="mono r dim">${p.dte != null ? p.dte + "d" : ""}</td>
      </tr>`).join("")}</tbody></table>
    </div>
    <div class="staging-actions">
      <button class="btn primary" id="monitor-merge">Merge &amp; refresh live book →</button>
      <button class="btn ghost" id="staging-clear">Discard</button>
    </div>
    <p class="fineprint">Nothing changes until you merge. After merging, every field stays editable in Live Book — so you can still override anything.</p>`;
  box.querySelector("#monitor-merge").addEventListener("click", mergeMonitor);
  box.querySelector("#staging-clear").addEventListener("click", () => {
    monitorParts = []; renderStaging(); logLine("Discarded the staged monitor slices.", "warn");
  });
}

// Commit the staged monitor slices into the persistent open book.
function mergeMonitor() {
  if (!monitorParts.length) { logLine("No monitor slices dropped yet.", "warn"); return; }
  const captureDate = new Date().toISOString().slice(0, 10);
  // Did any slice read faint? If so we flag the touched rows afterward so a
  // low-confidence monitor read is actionable instead of a dead log line.
  const lowConf = monitorParts.some((p) =>
    (p.flags || []).some((f) => /LOW_CONFIDENCE/.test(f)) || (p.confidence != null && p.confidence < 55));
  // 1) stitch + de-dup the parts into one position list
  const positions = mergeMonitorParts(monitorParts);
  state.monitor = positions;
  monitorParts = [];
  // 2) merge LIVE fields into the persistent store (update in place / add new)
  const { book, updated, added, seenKeys } = mergeMonitorIntoBook(state.openBook, positions, captureDate);
  state.openBook = book;
  // 3) positions that dropped off the blotter are closed
  const closed = reconcileClosed(state.openBook, seenKeys);
  // 4) retry any tickets captured before their position appeared
  retryPendingTickets();
  // 5) faint read → highlight the touched rows in Live Book for a second look
  if (lowConf) {
    for (const r of state.openBook) if (r.key && seenKeys.has(r.key)) r.needsReview = true;
  }
  save(); renderStaging(); renderBook(); renderTrack(); refreshReviewUI();
  logLine(`Merged ${positions.length} positions → book: ${updated} updated, ${added} new${closed ? `, ${closed} closed` : ""}.`, "ok");
  if (lowConf) logLine(`Some rows read faint — they're highlighted (⚠) in Live Book. Open it and double-check them against your screenshot.`, "warn");
  if (added) logLine(`${added} new position(s) need a one-time ticket/Curve capture (Max P/L, BP, credit/debit). Drop those screens to fill them.`, "warn");
}

// --- FEE config -------------------------------------------------------------
function initFees() {
  const f = state.fees;
  document.getElementById("fee-enabled").checked = f.enabled;
  document.getElementById("fee-open").value = f.perContractOpen;
  document.getElementById("fee-close").value = f.perContractClose;
  document.getElementById("fee-clear").value = f.clearingReg;
  const sync = () => {
    state.fees.enabled = document.getElementById("fee-enabled").checked;
    state.fees.perContractOpen = +document.getElementById("fee-open").value || 0;
    state.fees.perContractClose = +document.getElementById("fee-close").value || 0;
    state.fees.clearingReg = +document.getElementById("fee-clear").value || 0;
    document.getElementById("fee-note").textContent = state.fees.enabled
      ? "Showing NET of fees. Estimated per-leg; not from broker statements."
      : "OFF — numbers are gross, exactly as Ryan reported. Toggle to model fees.";
    save(); renderTrack();
  };
  ["fee-enabled", "fee-open", "fee-close", "fee-clear"].forEach((id) => document.getElementById(id).addEventListener("input", sync));
  sync();
}

// --- OCR ingest -------------------------------------------------------------
let monitorParts = [];

function initIngest() {
  const dz = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  dz.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => handleFiles([...e.target.files]));
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => handleFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/") || isCsv(f))));
  window.addEventListener("paste", (e) => {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile());
    if (imgs.length) handleFiles(imgs);
  });
}

function isCsv(file) {
  return /csv/i.test(file.type || "") || /\.csv$/i.test(file.name || "");
}

async function handleFiles(files) {
  if (!files.length) return;
  const log = document.getElementById("ocr-log");
  log.classList.add("show");
  for (const file of files) {
    if (isCsv(file)) { await handleCsvFile(file); continue; }
    logLine(`Reading ${file.name || "pasted image"}…`, "work");
    try {
      const res = await processScreenshot(file, (m) => {
        if (m.status && m.progress != null) setProgress(`${m.status} ${(m.progress * 100) | 0}%`);
      });
      ingestResult(res, file.name);
    } catch (err) {
      logLine(`✗ ${file.name}: ${err.message}`, "err");
    }
  }
  setProgress("");
}

// Capital Requirement CSV (tastytrade) → BP usage. No OCR; pure text parse.
async function handleCsvFile(file) {
  logLine(`Reading ${file.name}…`, "work");
  let text;
  try { text = await readFileText(file); }
  catch (err) { logLine(`✗ ${file.name}: could not read file (${err.message}).`, "err"); return; }
  const res = parseCapitalRequirementCsv(text);
  if (!res.ok) {
    logLine(`✗ ${file.name}: ${res.reason}. Expected the tastytrade Capital Requirement CSV (Symbol + Requirement / BP Usage %).`, "err");
    return;
  }
  ingestCapReq(res, file.name);
}

function ingestCapReq(res, name) {
  const captureDate = new Date().toISOString().slice(0, 10);
  const r = applyCapReqToBook(state.openBook, res, captureDate);
  // Headline BP usage for the Portfolio Summary gauge comes from the report total.
  state.summary = state.summary || {};
  const bp = state.summary.buying_power = state.summary.buying_power || {};
  if (res.total.bp_pct != null) bp.bp_usage_pct = round1(res.total.bp_pct);
  if (res.total.bp_usd != null) bp.bp_usage_usd = res.total.bp_usd;
  bp.bp_source = "capreq";
  bp.bp_asof = captureDate;
  save(); renderBook(); renderSummary();

  const parts = [`${res.rows.length} position(s) read`];
  if (r.filled) parts.push(`${r.filled} BP filled`);
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.ambiguous) parts.push(`${r.ambiguous} multi-position symbol(s) → summary only`);
  if (r.unmatched.length) parts.push(`${r.unmatched.length} not in book (${r.unmatched.slice(0, 5).join(", ")}${r.unmatched.length > 5 ? "…" : ""})`);
  const pctTxt = res.total.bp_pct != null ? ` · BP Usage ${round1(res.total.bp_pct)}%` : "";
  logLine(`✓ ${name}: Capital Requirement CSV — ${parts.join(", ")}${pctTxt}.`, "ok");
}

function ingestResult(res, name) {
  const flagTxt = (res.flags && res.flags.length) ? " — " + res.flags.join(" ") : "";
  const addReview = (items) => { if (items && items.length) { state.review.push(...items); } };
  if (res.layout === "spreadsheet") {
    // DEMOTED: the spreadsheet is the OUTPUT we generate, not the ongoing input.
    // Treat a dropped Type A as a one-time HISTORY IMPORT / back-fill — merge it
    // into the store without wiping live (monitor/ticket) positions.
    if (res.positions.length) {
      const { book, added, enriched } = importSpreadsheetIntoBook(state.openBook, res.positions);
      state.openBook = book;
      addReview(res.reviewItems);
      save(); renderBook(); refreshReviewUI();
      const nrev = (res.reviewItems || []).length;
      logLine(`✓ ${name}: history import (Type A) → ${added} added, ${enriched} enriched${nrev ? `, ${nrev} cell(s) to confirm` : ""}. Back-fill only; your live book comes from the Monitor.${flagTxt}`, nrev ? "warn" : "ok");
    } else logLine(`✗ ${name}: Type A detected but grid not segmented.${flagTxt}`, "err");
  } else if (res.layout === "curve") {
    // STATIC detail capture (Type C / ticket): fill Max P/L, BP, credit/debit.
    const r = applyTicketToBook(state.openBook, res.ticket, new Date().toISOString().slice(0, 10));
    if (r.matched) {
      save(); renderBook(); renderSummary();
      logLine(`✓ ${name}: ticket/Curve for ${res.ticket.symbol || "?"} → ${r.filled} static field(s) captured.${flagTxt}`, "ok");
    } else {
      state.pendingTickets.push(res.ticket);
      save();
      logLine(`• ${name}: ticket/Curve for ${res.ticket.symbol || "?"} held; no open position matches yet. Drop the Monitor and it will attach.${flagTxt}`, "warn");
    }
  } else if (res.layout === "order_chains") {
    if (res.bookable) {
      // Cross-week realized DEDUPE by position key: re-dropping the same CLSD
      // chain (e.g. the same weekly screenshot twice) must never double-book.
      // Key = ticker | strategy | realized P/L | close date.
      const closeDate = new Date().toISOString().slice(0, 10);
      const rkey = [
        (res.ticker || "?").toUpperCase(),
        (res.strategy || "Uncategorized").toLowerCase(),
        res.total_pl,
        closeDate,
      ].join("|");
      if ((state.trades || []).some((t) => t.realized_key === rkey)) {
        logLine(`• ${name}: ${res.ticker || "?"} CLSD chain already booked today (${money(res.total_pl, true)}) — skipped to avoid double-booking.${flagTxt}`, "warn");
      } else {
        state.trades.push({
          id: res.tradeId || ("ocr-" + Math.random().toString(36).slice(2, 8)),
          date_opened: "", date_closed: closeDate,
          ticker: res.ticker || "?", strategy: res.strategy || "Uncategorized",
          type: "", pl: res.total_pl, notes: "OCR'd CLSD chain" + flagTxt,
          realized_key: rkey, src: "ocr",
        });
        addReview(res.reviewItems);
        save(); renderTrack(); refreshReviewUI();
        logLine(`✓ ${name}: ${res.ticker || "?"} CLSD chain → realized ${money(res.total_pl, true)} booked.${flagTxt}`, "ok");
      }
    } else {
      logLine(`• ${name}: order chain not booked (${res.is_closed === false ? "still open" : "status unclear"}).${flagTxt}`, "warn");
    }
  } else if (res.layout === "monitor") {
    monitorParts.push(res);
    renderStaging();
    logLine(`• ${name}: monitor slice (${(res.positions || []).length} positions). Drop the rest, then hit “Merge & refresh live book” in the preview below.${flagTxt}`, "warn");
  } else {
    logLine(`• ${name}: ${res.layout} — skipped (context only).${flagTxt}`, "warn");
  }
}

// Re-attempt static captures that arrived before their position showed up.
function retryPendingTickets() {
  const still = [];
  for (const t of state.pendingTickets || []) {
    const r = applyTicketToBook(state.openBook, t, new Date().toISOString().slice(0, 10));
    if (!r.matched) still.push(t);
  }
  state.pendingTickets = still;
}

function logLine(msg, cls) {
  const log = document.getElementById("ocr-log");
  const d = document.createElement("div");
  d.className = "ll " + (cls || "");
  d.innerHTML = escapeHtml(msg);
  log.insertBefore(d, log.firstChild);
}
function setProgress(t) { document.getElementById("ocr-progress").textContent = t; }

// --- util -------------------------------------------------------------------
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// --- REVIEW panel + provisional ribbon -------------------------------------
function renderReview() {
  const c = document.getElementById("review-queue");
  if (!c) return;
  renderQueue(c, state, { save, refresh: refreshReviewUI, ai: aiHooks() });
}

// --- BYOK vision accelerator (opt-in, crop-only, key in sessionStorage) -----
let _visionConsented = false; // per-session; resets on reload

function visionCfg() {
  const v = state.vision;
  const prov = getProvider(v.provider);
  return { provider: v.provider, model: v.model || prov.defaultModel, baseUrl: v.baseUrl, key: getKey(v.provider) };
}

// AI is offered only when: enabled + provider not a stub + (a key exists OR a
// custom/local endpoint that may need none). Default OFF keeps privacy literal.
function aiReady() {
  const v = state.vision;
  if (!v.enabled) return false;
  const prov = getProvider(v.provider);
  if (prov.stub) return false;
  if (prov.custom) return !!v.baseUrl; // local may need no key
  return !!getKey(v.provider);
}

function aiHooks() {
  if (!aiReady()) return null;
  const prov = getProvider(state.vision.provider);
  const cfg = visionCfg();
  return {
    enabled: true,
    providerLabel: prov.label + (cfg.model ? " · " + cfg.model : ""),
    readOne: async (item) => { if (!confirmVisionConsent(prov.label)) return; await visionReadItem(item); save(); refreshReviewUI(); },
    readAll: async () => {
      if (!confirmVisionConsent(prov.label)) { refreshReviewUI(); return; }
      for (const it of reviewPending(state)) { await visionReadItem(it); }
      save(); refreshReviewUI();
    },
  };
}

function confirmVisionConsent(label) {
  if (_visionConsented) return true;
  const ok = confirm(`Send the cropped cell(s) to ${label} using your key?\n\nOnly the cropped cell is sent — never the full screenshot. Your key stays in this browser session and is sent only to that endpoint.`);
  if (ok) _visionConsented = true;
  return ok;
}

// Read ONE flagged cell's crop with vision; result re-enters the SAME review
// loop (re-validated, still requires human confirm; refuse-to-guess on null).
async function visionReadItem(item) {
  const dataUrl = cropToDataUrl(item.imageId, item.bbox, 8, 4); // generous pad/scale for the model
  const r = await readCropWithVision(dataUrl, visionCfg());
  item.engine = r.engine || item.engine;
  if (!r.ok) { item.msg = "AI: " + (r.error || "failed"); item.severity = item.severity || "check"; return r; }
  if (r.value == null) { item.msg = "AI unsure — confirm manually"; item.severity = "check"; return r; }
  // vision value becomes the proposed value; re-run the SAME validators.
  item.value = r.value;
  const validation = validateCell(item.field, r.value, r.value);
  item.suggested = validation.suggested;
  item.confidence = cellConfidence(85, validation); // vision nominal conf, gated by validator
  item.severity = "check"; // always keep human-in-the-loop for a vision read
  item.msg = validation.ok ? `AI read (${item.engine}) — confirm` : validation.msg;
  return r;
}

// Keep the badge, ribbon, and (if open) the queue + dashboards in sync.
function refreshReviewUI() {
  const ct = reviewCounts(state);
  // nav badge
  const badge = document.getElementById("review-badge");
  if (badge) {
    badge.textContent = ct.total;
    badge.classList.toggle("show", ct.total > 0);
    badge.classList.toggle("must", ct.must > 0);
  }
  // provisional ribbon
  const ribbon = document.getElementById("provisional");
  if (ribbon) {
    ribbon.classList.toggle("show", ct.total > 0);
    if (ct.total > 0) ribbon.querySelector("b").textContent = ct.total;
  }
  // the inline "confirm flagged reads" section (on Import) only shows when there
  // is actually something to confirm — keeps a first-time Import screen clean.
  const revBox = document.getElementById("import-review");
  if (revBox) revBox.hidden = ct.total === 0;
  // if Import is open and there are items, (re)render the queue in place
  const active = document.querySelector(".tab.active");
  if (active && active.dataset.tab === "import" && ct.total > 0) renderReview();
  // book/track rows may have changed via confirmations
  renderBook(); renderTrack(); refreshSampleBanner();
}

// --- SHARE panel: Weekly Card + JSON backup --------------------------------
function renderShare() {
  const p = state.cardPrefs || (state.cardPrefs = { handle: "@yourhandle", showDollars: false, weekEnding: "" });
  const handle = document.getElementById("card-handle");
  const dollars = document.getElementById("card-dollars");
  const week = document.getElementById("card-week");
  if (handle) handle.value = p.handle || "";
  if (dollars) dollars.checked = !!p.showDollars;
  if (week) week.value = p.weekEnding || "";
  // backup status
  const bs = document.getElementById("backup-status");
  if (bs) {
    const d = daysSinceBackup();
    bs.textContent = d === Infinity ? "No JSON backup yet." : `Last JSON backup ${d < 1 ? "today" : Math.floor(d) + "d ago"}.`;
    bs.classList.toggle("nudge", shouldNudge());
  }
  buildCardPreview();
}

function cardOpts() {
  const p = state.cardPrefs;
  const metrics = computeTrackRecord(state.trades, state.fees);
  return {
    handle: p.handle, weekEnding: p.weekEnding, showDollars: p.showDollars,
    metrics, provisional: reviewCounts(state).total,
    range: rangeLabel(metrics.firstDate, metrics.lastDate, metrics.n),
    sample: isSampleData(),
  };
}

async function buildCardPreview() {
  const wrap = document.getElementById("card-preview");
  if (!wrap) return;
  const cv = await renderCardCanvas(cardOpts(), 1);
  cv.style.width = "100%"; cv.style.height = "auto"; cv.style.display = "block";
  wrap.innerHTML = "";
  wrap.appendChild(cv);
  wrap.style.height = "auto";
}

async function exportCard(action) {
  const status = document.getElementById("card-status");
  status.textContent = "Rendering…";
  try {
    const ct = reviewCounts(state);
    const cv = await renderCardCanvas(cardOpts(), 2);
    if (action === "copy") {
      await copyCanvasToClipboard(cv);
      status.textContent = ct.total ? `Copied (⚠ ${ct.total} cells still unconfirmed).` : "Copied to clipboard ✓";
    } else {
      downloadCanvas(cv, "track-record-card.png");
      status.textContent = "Downloaded ✓";
    }
  } catch (err) {
    status.textContent = "✗ " + err.message + " — try Download instead.";
  }
}

function initShare() {
  const onPref = () => {
    state.cardPrefs.handle = document.getElementById("card-handle").value || "@yourhandle";
    state.cardPrefs.showDollars = document.getElementById("card-dollars").checked;
    state.cardPrefs.weekEnding = document.getElementById("card-week").value || "";
    save(); buildCardPreview();
  };
  ["card-handle", "card-dollars", "card-week"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", onPref);
  });
  document.getElementById("card-copy").addEventListener("click", () => exportCard("copy"));
  document.getElementById("card-download").addEventListener("click", () => exportCard("download"));
  document.getElementById("json-export").addEventListener("click", () => { exportJson(state); renderShare(); });
  document.getElementById("json-import").addEventListener("click", () => document.getElementById("json-file").click());
  document.getElementById("json-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const txt = await readFileText(f);
    const r = parseImport(txt);
    const status = document.getElementById("json-status");
    if (!r.ok) { status.textContent = "✗ " + r.error; return; }
    if (!confirm("Replace current data with the imported backup?")) return;
    state = { ...defaults(), ...r.state }; forgetImages(); save(); renderAll();
    status.textContent = "Imported ✓" + (r.warning ? " (" + r.warning + ")" : "");
  });
}

// --- BYOK vision settings UI ------------------------------------------------
function initVision() {
  const sel = document.getElementById("vision-provider");
  if (!sel) return;
  sel.innerHTML = PROVIDERS.map((p) => `<option value="${p.id}" ${p.stub ? "disabled" : ""}>${p.label}${p.stub ? " (next pass)" : ""}</option>`).join("");

  const enabled = document.getElementById("vision-enabled");
  const model = document.getElementById("vision-model");
  const baseUrl = document.getElementById("vision-baseurl");
  const baseWrap = document.getElementById("vision-baseurl-wrap");
  const keyEl = document.getElementById("vision-key");

  const syncFromState = () => {
    const v = state.vision;
    enabled.checked = !!v.enabled;
    sel.value = v.provider;
    const prov = getProvider(v.provider);
    model.value = v.model || "";
    model.placeholder = prov.defaultModel;
    baseUrl.value = v.baseUrl || "";
    baseWrap.style.display = prov.custom ? "" : "none";
    keyEl.value = getKey(v.provider); // from sessionStorage (this session only)
    paintVisionState();
  };

  const paintVisionState = () => {
    const v = state.vision;
    const prov = getProvider(v.provider);
    const st = document.getElementById("vision-state");
    const status = document.getElementById("vision-status");
    if (!v.enabled) { st.textContent = "off · default engine is on-device Tesseract"; }
    else { st.textContent = `on · ${prov.label}${aiReady() ? "" : " (needs " + (prov.custom ? "base URL" : "API key") + ")"}`; }
    if (status) {
      const keyHeld = !!getKey(v.provider);
      status.innerHTML = v.enabled
        ? `Crops only → <b>${prov.label}</b>. Key ${keyHeld ? "held in sessionStorage (this session)" : "not set"}. ${aiReady() ? '"Read with AI" is live in the queue below.' : "Add the missing field to enable."}`
        : "Disabled. Tesseract on-device remains the only engine.";
    }
    refreshReviewUI();
  };

  enabled.addEventListener("change", () => { state.vision.enabled = enabled.checked; save(); paintVisionState(); });
  sel.addEventListener("change", () => {
    state.vision.provider = sel.value; state.vision.model = ""; save(); syncFromState();
  });
  model.addEventListener("input", () => { state.vision.model = model.value.trim(); save(); paintVisionState(); });
  baseUrl.addEventListener("input", () => { state.vision.baseUrl = baseUrl.value.trim(); save(); paintVisionState(); });
  // KEY → sessionStorage ONLY, never state/localStorage.
  keyEl.addEventListener("input", () => { setKey(state.vision.provider, keyEl.value.trim()); paintVisionState(); });

  syncFromState();
}

// --- CSV export (build.py interop) -----------------------------------------
function exportCsv() {
  const ct = reviewCounts(state);
  if (ct.total && !confirm(`${ct.total} cell(s) are still unconfirmed (provisional). Export anyway?`)) return;
  const m = computeTrackRecord(state.trades, state.fees);
  const head = "date_closed,date_opened,ticker,strategy,type,realized_pl,notes";
  const rows = m.trades.map((t) => [t.date_closed, t.date_opened, t.ticker, t.strategy, t.type, state.fees.enabled ? t.plNet : t.gross, `"${(t.notes || "").replace(/"/g, '""')}"`].join(","));
  const blob = new Blob([head + "\n" + rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tt-track-record.csv";
  a.click();
}

// SAMPLE watermark: true while the book/record is still entirely the seeded
// demo (nothing OCR'd, imported, or live yet). Once the user adds their own
// data, the badge disappears so they never mistake Ryan's seed for their own.
function isSampleData() {
  const t = state.trades || [], b = state.openBook || [];
  if (!t.length && !b.length) return false;
  return t.every((x) => x.src === "seed") && b.every((x) => x.src === "seed");
}
function refreshSampleBanner() {
  const bar = document.getElementById("samplebar");
  if (bar) bar.hidden = !isSampleData();
}

function renderAll() {
  renderTrack(); renderBook(); renderStaging(); initFees(); refreshReviewUI(); refreshSampleBanner();
}

// --- theme (light / dark) ---------------------------------------------------
const THEME_KEY = "tt-tracker-theme";
// Explicit user choice wins; otherwise follow the OS preference on first load.
function loadTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}
function applyTheme(mode) {
  applyBrand(getBrand(ACTIVE_BRAND), mode);
  const dark = document.documentElement.dataset.theme === "dark";
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    const ico = document.getElementById("theme-ico");
    const lbl = document.getElementById("theme-lbl");
    // Button advertises the mode it switches TO, so the label reads as an action.
    if (ico) ico.textContent = dark ? "☀️" : "🌙";
    if (lbl) lbl.textContent = dark ? "Light" : "Dark";
    const tip = dark ? "Switch to light mode" : "Switch to dark mode";
    btn.title = tip;
    btn.setAttribute("aria-label", tip);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0c1020" : "#1b2a4a");
}

// --- boot -------------------------------------------------------------------
function boot() {
  // Apply brand config + theme first -- sets CSS vars, data-brand/data-theme, chrome.
  applyTheme(loadTheme());

  initTabs();
  initIngest();
  initShare();
  initVision();
  document.getElementById("reset-seed").addEventListener("click", resetSeed);
  document.getElementById("export-csv").addEventListener("click", exportCsv);
  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    renderAll(); // re-render the visible charts/tables under the new palette
  });
  const goRev = document.getElementById("provisional-go");
  if (goRev) goRev.addEventListener("click", () => {
    goToTab("import");
    const box = document.getElementById("import-review");
    if (box && !box.hidden) box.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  renderAll();
  window.addEventListener("resize", () => {
    const a = document.querySelector(".tab.active");
    if (!a) return;
    if (a.dataset.tab === "track") renderTrack();
    if (a.dataset.tab === "share") buildCardPreview();
  });
  // register service worker (scoped to this subpath)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", boot);
