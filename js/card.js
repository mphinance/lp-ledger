// card.js — the Weekly Card PNG export (the weekly ritual / share artifact).
// DETERMINISTIC Canvas 2D render (no foreignObject / no external lib) → renders
// identically everywhere, works offline, and is fully validatable headless.
// Brand-aware: reads palette + footer text from brand.js so the card matches
// the active whitelabel skin. Defaults to % + ratios with DOLLARS OFF
// (writers won't post account size); one toggle reveals $. Copy-to-clipboard
// is the default action; download is the fallback.

import { getBrand, ACTIVE_BRAND, loadLogoImage } from './brand.js';

const W = 1600, H = 900, PAD = 72;

// Build the canvas color palette from the active brand.
// card.* values are raw hex strings (CSS vars do not apply on <canvas>).
const _brand = getBrand(ACTIVE_BRAND);
const C = { ..._brand.card };

// Convenience alias: "gold" is the accent slot in brand.card; paint() uses C.gold.
// If brand defines it as "accent", map it through. (Both key names are fine.)
if (!C.gold && C.accent) C.gold = C.accent;

function fmtMoney(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  return `${s}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Preloaded logo image for canvas draw (null if not applicable).
let _logoImg = null;

async function ensureFonts() {
  if (!document.fonts || !document.fonts.load) return;
  try {
    const toLoad = [
      document.fonts.load("700 46px 'JetBrains Mono'"),
      document.fonts.load("500 18px 'JetBrains Mono'"),
    ];
    // Load whichever display font the active brand uses.
    if (_brand.id === 'lpLedger') {
      toLoad.push(document.fonts.load("800 36px 'Playfair Display'"));
      toLoad.push(document.fonts.load("700 15px 'Playfair Display'"));
    } else {
      toLoad.push(document.fonts.load("800 36px Archivo"));
      toLoad.push(document.fonts.load("600 15px Archivo"));
    }
    await Promise.all(toLoad);
    await document.fonts.ready;
  } catch (e) { /* fall back to system fonts */ }

  // Preload logo image for canvas
  _logoImg = await loadLogoImage(_brand);
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCurve(ctx, points, x, y, w, h) {
  if (!points.length) return;
  const ys = points.map((p) => p.equity);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const xAt = (i) => x + (i / Math.max(1, points.length - 1)) * w;
  const yAt = (v) => y + (1 - (v - yMin) / Math.max(1, yMax - yMin)) * h;
  const up = points[points.length - 1].equity >= 0;
  const col = up ? C.pos : C.neg;
  // zero baseline
  ctx.strokeStyle = "rgba(255,255,255,.16)"; ctx.setLineDash([5, 5]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, yAt(0)); ctx.lineTo(x + w, yAt(0)); ctx.stroke();
  ctx.setLineDash([]);
  // area
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, hexA(col, 0.32)); grad.addColorStop(1, hexA(col, 0));
  ctx.beginPath(); ctx.moveTo(xAt(0), yAt(0));
  points.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p.equity)));
  ctx.lineTo(xAt(points.length - 1), yAt(0)); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(xAt(i), yAt(p.equity)) : ctx.moveTo(xAt(i), yAt(p.equity))));
  ctx.strokeStyle = col; ctx.lineWidth = 3.5; ctx.lineJoin = "round"; ctx.stroke();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Brand-specific canvas helpers
const DISPLAY_FONT = _brand.id === 'lpLedger'
  ? "'Playfair Display', Georgia, serif"
  : "Archivo, sans-serif";

// Draw the whole card into a context already scaled to logical 1600x900 coords.
function paint(ctx, opts) {
  const m = opts.metrics, showD = !!opts.showDollars;
  // background
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // Ambient glow (brand-appropriate)
  let g;
  if (_brand.id === 'lpLedger') {
    // Subtle warm cream gradient -- barely visible
    g = ctx.createRadialGradient(W * 0.86, -80, 0, W * 0.86, -80, 600);
    g.addColorStop(0, "rgba(27,42,74,.06)"); g.addColorStop(1, "rgba(27,42,74,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else {
    g = ctx.createRadialGradient(W * 0.86, -120, 0, W * 0.86, -120, 700);
    g.addColorStop(0, "rgba(255,203,5,.10)"); g.addColorStop(1, "rgba(255,203,5,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(W * 0.04, -100, 0, W * 0.04, -100, 620);
    g.addColorStop(0, "rgba(74,144,226,.10)"); g.addColorStop(1, "rgba(74,144,226,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // Logo image (top-left, if brand has one)
  let titleX = PAD;
  if (_logoImg) {
    const logoSz = 48;
    ctx.drawImage(_logoImg, PAD, PAD + 4, logoSz, logoSz);
    titleX = PAD + logoSz + 14;
  }

  // title + subtitle
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.fillStyle = C.ink; ctx.font = `800 36px ${DISPLAY_FONT}`;
  ctx.fillText("Options Track Record", titleX, PAD + 30);
  ctx.fillStyle = C.muted; ctx.font = "500 18px 'JetBrains Mono', monospace";
  // Honest range label (never reads as all-time), e.g. "Feb-Jun 2026 · 18 weeks · 88 trades".
  const sub = (opts.weekEnding ? "week ending " + opts.weekEnding + " · " : "") +
    (opts.range || ((m.firstDate || "") + " → " + (m.lastDate || "")));
  ctx.fillText(sub, titleX, PAD + 64);

  // handle (hero) top-right
  ctx.textAlign = "right";
  ctx.fillStyle = C.gold; ctx.font = `800 36px ${DISPLAY_FONT}`;
  ctx.fillText(opts.handle || "@yourhandle", W - PAD, PAD + 30);
  ctx.fillStyle = C.muted; ctx.font = `600 14px ${DISPLAY_FONT}`;
  ctx.fillText(opts.sample ? "SAMPLE DATA" : "VERIFIED TRACK RECORD", W - PAD, PAD + 56);
  ctx.textAlign = "left";

  // SAMPLE watermark — unmistakable so a new user never posts the demo as their
  // own. Big translucent diagonal band across the card body when sample data.
  if (opts.sample) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-Math.atan2(H, W));
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `800 150px ${DISPLAY_FONT}`;
    ctx.fillStyle = _brand.id === "lpLedger" ? "rgba(27,42,74,.07)" : "rgba(255,255,255,.06)";
    ctx.fillText("SAMPLE", 0, 0);
    ctx.restore();
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }

  // equity curve
  drawCurve(ctx, m.equity, PAD, 168, W - PAD * 2, 260);

  // tiles
  const tiles = [
    { v: m.winRate != null ? m.winRate + "%" : "—", l: "Win Rate", c: C.gold, accent: C.gold },
    { v: m.profitFactor != null ? m.profitFactor.toFixed(2) : "—", l: "Profit Factor", c: C.ink, accent: C.pos },
    { v: String(m.n), l: "Closed Trades", c: C.ink, accent: C.line },
  ];
  if (showD) {
    const net = m.useNet ? m.total : m.grossTotal;
    tiles.push({ v: fmtMoney(net), l: "Net P/L", c: net >= 0 ? C.pos : C.neg, accent: net >= 0 ? C.pos : C.neg });
  }
  const ty = 478, th = 150, gap = 20;
  const tw = (W - PAD * 2 - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((t, i) => {
    const tx = PAD + i * (tw + gap);
    ctx.fillStyle = C.surface; rr(ctx, tx, ty, tw, th, 18); ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; rr(ctx, tx + .5, ty + .5, tw - 1, th - 1, 18); ctx.stroke();
    ctx.fillStyle = t.accent; rr(ctx, tx, ty, 5, th, 3); ctx.fill();
    ctx.fillStyle = t.c; ctx.font = "700 48px 'JetBrains Mono', monospace";
    ctx.fillText(t.v, tx + 28, ty + 70);
    ctx.fillStyle = C.muted; ctx.font = `600 15px ${DISPLAY_FONT}`;
    ctx.fillText(t.l.toUpperCase(), tx + 28, ty + 108);
  });

  // best / worst strategy line
  const best = m.strategies[0], worst = m.strategies[m.strategies.length - 1];
  ctx.font = "500 19px 'JetBrains Mono', monospace";
  let lx = PAD, lyy = 690;
  if (best) {
    ctx.fillStyle = C.muted; ctx.fillText("Best strategy ", lx, lyy);
    lx += ctx.measureText("Best strategy ").width;
    const txt = best.strategy + " " + (showD ? fmtMoney(best.total) : best.winRate + "% win");
    ctx.fillStyle = C.pos; ctx.fillText(txt, lx, lyy);
  }
  if (worst && worst !== best) {
    lx = PAD; lyy = 724;
    ctx.fillStyle = C.muted; ctx.fillText("Worst strategy ", lx, lyy);
    lx += ctx.measureText("Worst strategy ").width;
    const txt = worst.strategy + " " + (showD ? fmtMoney(worst.total) : worst.winRate + "% win");
    ctx.fillStyle = C.neg; ctx.fillText(txt, lx, lyy);
  }

  // footer credit (muted ~40% -- brand's footer string)
  const footerAlpha = _brand.id === 'lpLedger' ? "rgba(27,42,74,.40)" : "rgba(255,255,255,.40)";
  ctx.fillStyle = footerAlpha; ctx.font = "500 15px 'JetBrains Mono', monospace";
  ctx.fillText(C.footer || "built with mphinance", PAD, H - 36);

  // provisional tag
  if (opts.provisional) {
    ctx.textAlign = "right";
    ctx.fillStyle = C.gold; ctx.font = "700 14px 'JetBrains Mono', monospace";
    ctx.fillText(`⚠ PROVISIONAL · ${opts.provisional} unconfirmed`, W - PAD, H - 36);
    ctx.textAlign = "left";
  }
}

export async function renderCardCanvas(opts, scale = 2) {
  await ensureFonts();
  const cv = document.createElement("canvas");
  cv.width = W * scale; cv.height = H * scale;
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  paint(ctx, opts);
  return cv;
}

export async function cardDataUrl(opts, scale = 2) {
  const cv = await renderCardCanvas(opts, scale);
  return cv.toDataURL("image/png");
}

export function canvasToBlob(cv) {
  return new Promise((res) => cv.toBlob(res, "image/png"));
}

export async function copyCanvasToClipboard(cv) {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error("Clipboard image not supported here — use Download.");
  const blob = await canvasToBlob(cv);
  await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
}

export function downloadCanvas(cv, name) {
  const a = document.createElement("a");
  a.href = cv.toDataURL("image/png"); a.download = name || "track-record-card.png"; a.click();
}
