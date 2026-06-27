// charts.js — dependency-free inline SVG charts (offline-safe, tastytrade-styled).
// Equity curve with green/red payoff-style shading, horizontal strategy bars,
// and BP gauges. No external chart lib so the PWA works fully offline.

const NS = "http://www.w3.org/2000/svg";
const POS = "#27c19a", NEG = "#f6465c", GOLD = "#ffcb05", GRID = "rgba(255,255,255,.05)", MUT = "#7d828f";

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export function money(v, sign = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = sign && v > 0 ? "+" : "";
  return `${s}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.replace("$", v < 0 ? "-$" : "$").replace("--", "-");
}
export function moneyInt(v) {
  if (v === null || v === undefined || v === "") return "";
  if (String(v).toLowerCase() === "inf") return "∞";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// --- Equity curve -----------------------------------------------------------
export function drawEquityCurve(container, points, tip) {
  container.innerHTML = "";
  if (!points.length) { container.innerHTML = '<div class="empty">No closed trades yet.</div>'; return; }
  const W = container.clientWidth || 800, H = 260;
  const padL = 56, padR = 14, padT = 16, padB = 26;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, preserveAspectRatio: "none" }, container);

  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.equity);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const xAt = (i) => padL + (i / Math.max(1, points.length - 1)) * (W - padL - padR);
  const yAt = (v) => padT + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * (H - padT - padB);

  // gridlines + y labels
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = yMin + (t / ticks) * (yMax - yMin);
    const y = yAt(v);
    el("line", { x1: padL, y1: y, x2: W - padR, y2: y, stroke: GRID, "stroke-width": 1 }, svg);
    const lbl = el("text", { x: padL - 8, y: y + 3, "text-anchor": "end", fill: MUT, "font-size": 10, "font-family": "JetBrains Mono, monospace" }, svg);
    lbl.textContent = "$" + Math.round(v).toLocaleString();
  }
  // zero baseline emphasised
  const zeroY = yAt(0);
  el("line", { x1: padL, y1: zeroY, x2: W - padR, y2: zeroY, stroke: "rgba(255,255,255,.18)", "stroke-width": 1, "stroke-dasharray": "3 3" }, svg);

  // build path + split area above/below zero for payoff shading
  let line = "";
  points.forEach((p, i) => { line += (i ? "L" : "M") + xAt(i) + " " + yAt(p.equity) + " "; });

  // green fill (area between curve and zero where >=0), red where <0
  const defs = el("defs", {}, svg);
  const gp = el("linearGradient", { id: "eqUp", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el("stop", { offset: "0%", "stop-color": POS, "stop-opacity": ".34" }, gp);
  el("stop", { offset: "100%", "stop-color": POS, "stop-opacity": "0" }, gp);
  const gn = el("linearGradient", { id: "eqDn", x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
  el("stop", { offset: "0%", "stop-color": NEG, "stop-opacity": ".30" }, gn);
  el("stop", { offset: "100%", "stop-color": NEG, "stop-opacity": "0" }, gn);

  // area to zero
  let area = "M" + xAt(0) + " " + zeroY + " ";
  points.forEach((p, i) => { area += "L" + xAt(i) + " " + yAt(p.equity) + " "; });
  area += "L" + xAt(points.length - 1) + " " + zeroY + " Z";
  const ended = points[points.length - 1].equity >= 0;
  el("path", { d: area, fill: ended ? "url(#eqUp)" : "url(#eqDn)" }, svg);

  el("path", { d: line, fill: "none", stroke: ended ? POS : NEG, "stroke-width": 2.2, "stroke-linejoin": "round" }, svg);

  // hover dots + interaction layer
  const dot = el("circle", { r: 4, fill: GOLD, stroke: "#0a0a0b", "stroke-width": 2, opacity: 0 }, svg);
  const overlay = el("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" }, svg);
  overlay.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let idx = Math.round(((px - padL) / (W - padL - padR)) * (points.length - 1));
    idx = Math.max(0, Math.min(points.length - 1, idx));
    const p = points[idx];
    dot.setAttribute("cx", xAt(idx)); dot.setAttribute("cy", yAt(p.equity)); dot.setAttribute("opacity", 1);
    if (tip) tip(p, e);
  });
  overlay.addEventListener("mouseleave", () => { dot.setAttribute("opacity", 0); if (tip) tip(null); });
}

// --- Strategy horizontal bars ----------------------------------------------
export function drawStrategyBars(container, rows) {
  container.innerHTML = "";
  if (!rows.length) { container.innerHTML = '<div class="empty">No strategy data.</div>'; return; }
  const max = Math.max(...rows.map((r) => Math.abs(r.total)), 1);
  for (const r of rows) {
    const pos = r.total >= 0;
    const wrap = document.createElement("div");
    wrap.className = "sbar";
    wrap.innerHTML = `
      <div class="sbar-h"><span class="sbar-name">${escapeHtml(r.strategy)}</span>
        <span class="sbar-val ${pos ? "pos" : "neg"}">${money(r.total, true)}</span></div>
      <div class="sbar-track"><i style="width:${(Math.abs(r.total) / max) * 100}%;background:${pos ? POS : NEG}"></i></div>
      <div class="sbar-sub">${r.count} trade${r.count !== 1 ? "s" : ""} · ${r.winRate}% win</div>`;
    container.appendChild(wrap);
  }
}

// --- BP gauge (linear) ------------------------------------------------------
export function gaugeHtml(label, pct, color = GOLD) {
  const p = Number(pct);
  const val = Number.isFinite(p) ? p : 0;
  return `<div class="g-row"><span>${label}</span><span class="g-val">${Number.isFinite(p) ? p + "%" : "—"}</span></div>
    <div class="g-bar"><i style="width:${Math.min(val, 100)}%;background:${color}"></i></div>`;
}

// --- Donut for position mix -------------------------------------------------
export function drawDonut(container, segs) {
  // segs: [{label, pct, color}]
  container.innerHTML = "";
  const size = 92, r = 38, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  const svg = el("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size }, container);
  el("circle", { cx, cy, r, fill: "none", stroke: "rgba(255,255,255,.07)", "stroke-width": 10 }, svg);
  let off = 0;
  for (const s of segs) {
    const len = (s.pct / 100) * C;
    const c = el("circle", { cx, cy, r, fill: "none", stroke: s.color, "stroke-width": 10, "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": -off, transform: `rotate(-90 ${cx} ${cy})` }, svg);
    off += len;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
