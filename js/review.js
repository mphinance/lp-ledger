// review.js — the crop-thumbnail confirmation queue (THE trust surface).
// Shows ONLY flagged cells. Each shows the cropped SOURCE PIXELS beside an
// editable field + suggested fix. Confirm a picture, don't re-read the source.
// Keyboard-first: Enter = accept, type = correct, Tab/↓ = next.
//
// Crops render from the in-session image registry in ocr.js — image bytes are
// never persisted; only the parsed value + bbox metadata live in state.

import { cropToDataUrl } from "./ocr.js";

const MONEY_FIELDS = new Set(["credit_rcvd", "debit_paid", "max_profit", "max_loss", "bp_usd", "bp_pct", "pl"]);

export function pending(state) { return (state.review || []).filter((i) => !i.confirmed); }
export function counts(state) {
  const p = pending(state);
  return { total: p.length, must: p.filter((i) => i.severity === "must").length, check: p.filter((i) => i.severity === "check").length };
}

function coerce(field, txt) {
  txt = (txt == null ? "" : String(txt)).trim();
  if (MONEY_FIELDS.has(field)) {
    if (txt === "" ) return null;
    if (txt === "∞" || /^inf/i.test(txt)) return "inf";
    const n = Number(txt.replace(/[,$%]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return txt || null;
}

function rowFor(state, item) {
  if (item.kind === "book") return (state.openBook || []).find((r) => r.id === item.rowId);
  return (state.trades || []).find((r) => r.id === item.rowId);
}

// Write a confirmed value back into the underlying row + mark item confirmed.
function applyValue(state, item, value) {
  const row = rowFor(state, item);
  if (row) {
    row[item.field] = value;
    // clear the row-level needsReview once none of its items remain pending
    const stillPending = pending(state).some((i) => i.rowId === item.rowId && i.id !== item.id);
    if (!stillPending) delete row.needsReview;
  }
  item.confirmed = true;
  item.value = value;
}

// Render the queue into `container`. hooks = { save, refresh }.
export function renderQueue(container, state, hooks) {
  const items = pending(state);
  container.innerHTML = "";

  if (!items.length) {
    container.innerHTML = `<div class="rv-empty">
      <div class="rv-empty-ic">✓</div>
      <h3>Nothing to confirm</h3>
      <p>Every OCR'd cell is high-confidence and auto-accepted, or you've cleared the queue. The dashboard is no longer provisional.</p>
    </div>`;
    return;
  }

  const active = items[0];
  const rest = items.slice(1);

  // progress
  const totalEver = (state.review || []).length;
  const done = totalEver - items.length;
  const head = document.createElement("div");
  head.className = "rv-head";
  head.innerHTML = `
    <div class="rv-count"><b>${items.length}</b> to confirm
      <span class="rv-sev must">${counts(state).must}🔴</span>
      <span class="rv-sev check">${counts(state).check}🟡</span>
    </div>
    <div class="rv-prog"><i style="width:${totalEver ? (done / totalEver) * 100 : 0}%"></i></div>
    ${hooks.ai && hooks.ai.enabled ? `<button class="btn ghost small show" id="rv-ai-all" title="Sends each flagged crop to ${esc(hooks.ai.providerLabel)}">✨ Read all flagged with AI</button>` : ""}
    <button class="btn ghost small show" id="rv-acceptall">Accept all remaining</button>`;
  container.appendChild(head);

  // active card with crop
  const card = document.createElement("div");
  card.className = "rv-card active " + active.severity;
  const crop = cropToDataUrl(active.imageId, active.bbox);
  const dispVal = active.value === "inf" ? "∞" : (active.value == null ? "" : active.value);
  const sug = active.suggested != null ? String(active.suggested) : null;
  const aiOn = !!(hooks.ai && hooks.ai.enabled);
  card.innerHTML = `
    <div class="rv-card-h">
      <span class="rv-pill ${active.severity}">${active.severity === "must" ? "🔴 confirm" : "🟡 check"}</span>
      <span class="rv-desc">${esc(active.desc)} · <b>${fieldLabel(active.field)}</b></span>
      ${active.engine ? `<span class="rv-engine">read by ${esc(active.engine)}</span>` : ""}
      <span class="rv-conf">conf ${active.confidence}%</span>
    </div>
    <div class="rv-crop">${crop ? `<img src="${crop}" alt="source crop"/>` : `<div class="rv-nocrop">source image not in this session — read from your own copy and type the value</div>`}</div>
    ${active.msg ? `<div class="rv-msg">${esc(active.msg)}</div>` : ""}
    <div class="rv-edit">
      <input id="rv-input" type="text" value="${esc(String(dispVal))}" autocomplete="off" spellcheck="false" />
      ${sug ? `<button class="btn small show" id="rv-usesug">use ${esc(sug)}</button>` : ""}
      <button class="btn small show" id="rv-skip">skip</button>
      <button class="btn primary" id="rv-accept">Accept ⏎</button>
    </div>
    ${aiOn ? `<div class="rv-ai">
      <button class="btn small show" id="rv-ai-one">✨ Read with AI</button>
      <span class="rv-ai-consent">→ this crop only will be sent to <b>${esc(hooks.ai.providerLabel)}</b> with your key</span>
    </div>` : ""}
    <div class="rv-hint">Enter to accept · type to correct · Tab for next · this confirms a <b>picture</b>, not the source</div>`;
  container.appendChild(card);

  // upcoming list
  if (rest.length) {
    const list = document.createElement("div");
    list.className = "rv-list";
    list.innerHTML = `<div class="rv-list-h">Up next</div>` + rest.map((it) => `
      <div class="rv-row ${it.severity}">
        <span class="rv-dot ${it.severity}"></span>
        <span class="rv-row-desc">${esc(it.desc)} · ${fieldLabel(it.field)}</span>
        <span class="rv-row-val">${it.value === "inf" ? "∞" : esc(String(it.value ?? "—"))}</span>
        <span class="rv-row-conf">${it.confidence}%</span>
      </div>`).join("");
    container.appendChild(list);
  }

  // wiring
  const input = card.querySelector("#rv-input");
  const commit = (val) => { applyValue(state, active, coerce(active.field, val)); hooks.save(); hooks.refresh(); };
  card.querySelector("#rv-accept").addEventListener("click", () => commit(input.value));
  const useSug = card.querySelector("#rv-usesug");
  if (useSug) useSug.addEventListener("click", () => { input.value = sug; input.focus(); });
  card.querySelector("#rv-skip").addEventListener("click", () => {
    // move to back of queue without confirming
    const arr = state.review;
    const idx = arr.indexOf(active);
    if (idx >= 0) { arr.splice(idx, 1); arr.push(active); }
    hooks.save(); hooks.refresh();
  });
  head.querySelector("#rv-acceptall").addEventListener("click", () => {
    for (const it of pending(state)) applyValue(state, it, it.value);
    hooks.save(); hooks.refresh();
  });
  const aiOneBtn = card.querySelector("#rv-ai-one");
  if (aiOneBtn && hooks.ai) aiOneBtn.addEventListener("click", async () => {
    aiOneBtn.disabled = true; aiOneBtn.textContent = "✨ reading…";
    await hooks.ai.readOne(active); // app re-renders the queue on completion
  });
  const aiAllBtn = head.querySelector("#rv-ai-all");
  if (aiAllBtn && hooks.ai) aiAllBtn.addEventListener("click", async () => {
    aiAllBtn.disabled = true; aiAllBtn.textContent = "✨ reading all…";
    await hooks.ai.readAll();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(input.value); }
    else if (e.key === "Tab") { /* default Tab handled by skip-less focus; let it bubble to accept-as-is */ }
  });
  // autofocus + select for instant typing
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function fieldLabel(f) {
  return ({
    trade_description: "Description", credit_rcvd: "Credit", debit_paid: "Debit",
    max_profit: "Max Profit", max_loss: "Max Loss", bp_usd: "BP $", bp_pct: "BP %",
    position_type: "Position", risk_type: "Risk", date_opened: "Opened",
    pl: "Realized P/L", ticker: "Ticker",
  })[f] || f;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
