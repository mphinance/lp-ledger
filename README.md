# TT Tracker — tastytrade options track record + live book

A static, client-side **Progressive Web App** that turns tastytrade screenshots into a
clean options **track record** (equity curve, win rate, profit factor, per-strategy
breakdown) and a **live book & risk** view — all via **in-browser OCR**. No backend, no
broker login, no upload.

**Live:** https://mphinance.github.io/lp-ledger/

It ships seeded with **Ryan LePiane's** full verified public record (clearly watermarked
**SAMPLE** in-app) so it looks alive on first load: **88 closed trades, +$33,520.37 realized,
81.8% win rate, 6.67 profit factor over Feb–Jun 2026 (18 weeks)**, plus **12 open positions**
in the live book. The Track Record panel and the Weekly Card both carry an honest range label
(`Feb–Jun 2026 · 18 weeks · 88 trades`) so the number never reads as all-time. It generalizes
to **any tastytrade user** — drop your own screenshots and they replace the sample.

A free gift for Ryan, and a portfolio piece for [Momentum Phinance](https://mphinance.substack.com).
Go subscribe to [**Ryan LePiane — LP Options Academy**](https://ryanlepiane.substack.com).

---

## Screenshots

### Track Record Panel
![Track Record](assets/track_record.png)

### Live Book & Risk Panel
![Live Book](assets/live_book.png)

### Weekly Card Export
![Weekly Card](assets/weekly_card.png)

### AI Assist (BYOK) Settings
![AI Settings](assets/settings.png)

---

## The privacy model (the whole point)

Everything runs **on your device**. Screenshots are read by **Tesseract.js (WASM)** inside
your browser tab and **never leave your computer**. There is no server to send them to.
State (your edits + OCR'd rows) persists to **localStorage** — still on-device. The only
network calls are the one-time fetch of the OCR engine + fonts from a CDN (then cached by
the service worker for offline use).

## How to use it

1. Open the app. It loads with Ryan's verified seed so you can see the shape of it.
2. Go to **Import**. Drag, paste (Ctrl/Cmd-V), or click to add tastytrade screenshots —
   **drop as many at once as you like**; the app sorts out what each one is.
3. The app detects the layout, OCRs it on-device, and routes the data. The inputs are
   the tastytrade BROKER screens; the 10-column spreadsheet is the OUTPUT the app
   assembles for you (it replaces the sheet, so it never reads it as a live input):
   - **Active / Positions Monitor (Type E)** → the **PRIMARY open book**. Drop its slices
     weekly (usually 3 stitched images) — a **preview appears right on the Import panel** so
     you can eyeball it, then hit **Merge & refresh live book**. That refreshes the LIVE fields
     (P/L Open, P/L Opn%, Mark, Trade Price, Days Open, DTE) on every position; the headline
     **P/L Open** now shows as a column in the Live Book. New names are added and flagged for a
     one-time ticket capture. (Nothing is committed until you merge, and every field stays
     editable afterward — so the merge is a checkpoint, not a point of no return.)
   - **Order ticket / Curve (Type C)** → the per-trade **STATIC detail** captured once at open:
     Max Profit, Max Loss, BP $/%, Credit/Debit. These don't change after entry.
   - **Order Chains, fully CLSD (Type B)** → books a realized trade onto the **Track Record**.
   - **Type A Positions Spreadsheet** → **optional one-time history import** (back-fill). It no
     longer drives the live book; it just seeds your past.
   - **Capital Requirement CSV (tastytrade)** → drop the `.csv` export from tastytrade's
     positions risk panel to **import your BP Usage** without OCR. It fills each position's
     **BP $/%** (matched by underlying) and drives the portfolio **BP Usage** gauge from the
     report total. Read straight from the file — never uploaded, same on-device promise.
4. **Confirm the flagged reads.** Anything OCR wasn't sure about surfaces in a **Confirm
   flagged reads** queue *right on the Import panel* (the number on the **Import** tab counts
   them) — you confirm a cropped picture, not the source. High-confidence cells auto-accept.
   Every Live Book cell is also click-to-edit; Position (Core/Supp) and Risk (Def/Undef) are
   dropdowns, and low-confidence rows are highlighted "needs review".
5. **Reset** restores Ryan's seed. **Export** downloads your track record as CSV.
6. **Install** it (browser "Install app") for an offline, standalone PWA.
7. Toggle **dark / light** with the 🌙 / ☀️ button in the top bar. It follows your OS
   preference on first load and remembers your explicit choice after that.

### Risk Type & Position Type
- **Risk Type is auto-derived** and editable: spreads / butterflies / condors / zebras /
  diagonals / covered / long options = **Defined**; naked short puts/calls, strangles/
  straddles, long futures = **Undefined**. (Derivation validated against all of Ryan's own
  rows — long LEAPS correctly read Defined.) A `·d` badge marks a derived value.
- **Position Type (Core/Supp)** is your discretionary tag — never derived, always editable.

### Fees
A fee model (per-contract open/close + clearing/reg) is included but **OFF by default** and
a no-op, so the headline numbers stay gross and reconcile exactly to Ryan's reported totals.
Toggle it on to see gross vs net; it's an estimate, not from broker statements.

---

## Architecture

Pure static files, no build step. ES modules.

| File | Role |
|---|---|
| `index.html` / `css/app.css` | App shell + tastytrade theme |
| `js/seed.js` | Verified seed data (auto-generated from the reconciled CSVs) |
| `js/engine.js` | Realized-PnL + stats (`computeTrackRecord`, `winRate`, tolerant coercion) + equity-curve / avg-win-loss / profit-factor recipe, plus `deriveRiskType` (Def/Undef), `derivePositionType` (Core/Supp smart default), and `rangeLabel`. Reconciles to +$33,520.37 / 81.8% / 6.67 over 88 closed trades. |
| `js/ocr.js` | Tesseract.js wrapper + layout detection + **gridline column/row segmentation** (ported from `tt_ocr.py`) + parsers (∞ glyph, bond-ticks, bottom-crop detection). Records per-cell bbox + confidence and emits review items. Holds the in-session image registry (crops never persisted). Never fabricates. |
| `js/validators.js` | Per-column validators (money/%/date/ticker/Core-Supp/Def-Undef + cross-foot). `confidence = min(OCR conf, validator pass)` — catches the dangerous high-confidence misreads (`1,250` → `1.250`). |
| `js/review.js` | The crop-thumbnail confirmation queue: shows only flagged cells with the cropped source pixels + editable field + suggested fix. Keyboard-first. |
| `js/charts.js` | Dependency-free inline-SVG equity curve (green/red payoff shading), strategy bars, BP gauges, mix donuts — so it works fully offline. |
| `js/card.js` | The Weekly Card export — a **deterministic Canvas 2D render** (1600×900, no external lib, works offline) → copy-to-clipboard / download PNG. |
| `js/backup.js` | First-class JSON export/import with a `schemaVersion` stamp + migration shim + >7-day backup nudge. |
| `js/csv.js` | tastytrade **Capital Requirement CSV** import — dependency-free RFC-4180 reader + tolerant `$`/`(neg)`/`%` number parsing + fuzzy header-role detection (Requirement / Buying Power Effect, BP Usage %, Initial/Maintenance Requirement). Feeds per-position BP $/% and the portfolio BP-usage total. Never fabricates. Validated headless in `js/capreq.test.mjs`. |
| `js/app.js` | State, localStorage, panels, drag/drop + paste ingest, editing, review wiring, provisional ribbon, share. |
| `manifest.json` / `sw.js` | PWA manifest + service worker (scoped to `/lp-ledger/`), caching the app shell **and** the Tesseract WASM + `eng.traineddata` for offline OCR. |

### Review loop, Weekly Card, backups (v0.2 additive)

- **Crop-thumbnail review loop (the trust surface).** High-confidence cells auto-accept and
  collapse; you only touch the flagged ones. Each flagged cell shows the **cropped source
  pixels** from your screenshot beside an editable field + a suggested fix — you confirm a
  picture, you don't re-read the source. Keyboard-first (Enter = accept, type = correct,
  Tab/skip = next), a counter that ticks down, 🔴 must-confirm / 🟡 check severity. A
  **"Provisional — N unconfirmed"** ribbon shows on every panel until the queue hits 0, and
  CSV export warns while provisional, so a wrong number can't be exported silently. The crop
  lives only in an in-session canvas registry — **image bytes are never written to disk or
  localStorage**; only the parsed value + bbox metadata persist.
- **Weekly Card.** A deterministic 1600×900 PNG: title + week-ending + your **handle**
  (the hero), mini equity curve, KPI tiles (Win rate / Profit factor / Trades / Net P&L),
  best/worst strategy. **Defaults to % + ratios with dollars OFF** (writers won't post
  account size); one toggle reveals $. **Copy-to-clipboard** is the primary action;
  Download PNG is the fallback. Muted `tt-tracker · mphinance` footer reads as a chart
  credit. Card prefs (handle, $/%, week) persist to localStorage for a 20-second ritual.
- **Backups.** JSON export/import is the lossless cross-device path; CSV stays for `build.py`
  interop. A nudge appears if your last JSON backup is >7 days old.

### BYOK vision accelerator (HYBRID OCR — opt-in, `js/vision.js`)

The default read path stays **pure on-device Tesseract** (privacy literal). The vision
accelerator is an **opt-in, provider-agnostic BYOK layer** offered only on flagged cells,
plugged into the same review-loop seam (`processScreenshot` → per-cell
`{value, bbox, confidence}` → validators → review items).

- **Adapter interface:** `{ id, label, defaultModel, family, stub?, custom?, buildRequest(dataUrl, prompt, cfg) → {url, headers, body}, parseResponse(json) → text }`.
- **Providers wired now (one OpenAI-compatible code path):**
  - **OpenRouter** (`openrouter.ai/api/v1/chat/completions`) — the **default**, editable model.
  - **OpenAI / ChatGPT** (`api.openai.com/v1/chat/completions`).
  - **Custom / local** — supply a base URL + model → **Ollama** (`http://localhost:11434/v1`), **LM Studio** (`http://localhost:1234/v1`), **vLLM**, **llama.cpp** with open-source vision models (llama3.2-vision, qwen2-VL…). No key required for local.
  - All three use the OpenAI vision message format (`content` array, `type:image_url`, data-URL base64 of the crop).
- **Next-pass stubs (registry slots present, not selectable for live send):** native **Anthropic** (messages API + `anthropic-dangerous-direct-browser-access`) and **Google Gemini** (`generateContent` / `inline_data`) — shown disabled in the picker, labelled "(next pass)".
- **Privacy + key handling:** vision is **OFF by default**. Only the **cropped cell** is ever sent — never the full screenshot. The API key lives in **sessionStorage only** — never localStorage, never persisted, sent only to the chosen endpoint (verified headless: absent from localStorage, present in sessionStorage). An explicit **per-use consent line names the provider**, plus a first-use confirm.
- **Re-enters the same loop:** a vision read flows back through the **same validators**, fills the proposed value, tags the item with the engine (`read by openrouter:<model>`), and **still requires human confirm/override** — never auto-booked. Refuse-to-guess preserved (model unsure → null + flag); the tight `{value,type}` JSON prompt makes `parseResponse` deterministic.

The theme: near-black charcoal surfaces, dense data-forward grid, JetBrains Mono tabular
numerics, green gains / red losses, a bright tasty-gold accent, and the platform's
GAIN/LOSS/OPEN/CLSD color language — a native-feeling extension of the tastytrade UI the
screenshots came from.

---

## OCR scope & honest accuracy

Validated against the real public screenshots in the build corpus (118 images, 8 weeks).
Tesseract.js runs in the browser, so character-level read accuracy can't be benchmarked in
CI here — what was validated is the **layout-detection and geometric segmentation** (the
JS pixel logic was replicated against the real images), which is what makes or breaks the
read. Honest status by layout:

> **2026-06 re-point (Option A):** the data flow was corrected. LP Ledger REPLACES the
> hand-kept spreadsheet, so the spreadsheet is the OUTPUT, not the input. The Monitor is now
> the PRIMARY source and the spreadsheet is a one-time history import. Tiers below reflect that.

- **PRIMARY — Type E Active / Positions Monitor:** the live open book. A real structured
  parser anchors each row's numeric tail on the single `P/L Opn%` token (the one reliable
  landmark — all price-chip numbers sit left of it), then reads P/L Open / Mark / Trade Price
  / D's Opn / DTE off it; the chip's own `##d` never leaks into a column. Three-level hierarchy
  (underlying → strategy → leg) is reconstructed, and the 3 stitched images are concatenated +
  de-duped at the seam (a position split across the seam is unioned; repeated legs are dropped).
  The pure parser is validated headless against transcribed real lines (`js/repoint.test.mjs`).
- **STATIC — Type C order ticket / Curve:** captured once at open for Max Profit, Max Loss,
  BP $/%, Credit/Debit. No longer skipped. `parseInf` now keeps a real `$0` as `0` (only the
  ∞ glyph / the word "infinity" means Unlimited).
- **REALIZED — Type B Order Chains:** ticker / Total P/L / status regions are cropped and
  OCR'd. **Gated correctly**: any "Open Pos" block ⇒ live, **not** booked. Bond-tick (`109'12`)
  parsed as 32nds. Cropped headers flag low-confidence so you set the symbol manually.
- **ONE-TIME IMPORT — Type A Positions Spreadsheet:** demoted to a back-fill path. Gridline
  segmentation still isolates the 10 columns; it now MERGES into the store (enriching live
  rows' static fields, appending unseen history) instead of replacing the book.

The persistent open-positions store (`js/store.js`, localStorage, parsed data only — never
images) keys each position by symbol + option-leg signature (or symbol + open date for
futures/stock). Static fields come from the ticket capture; live fields refresh on every
Monitor drop; a position that drops off the Monitor is reconciled closed.

Guiding rule throughout: **never fabricate.** Low-confidence or unreadable values emit
`null` + a visible "needs review" flag.

---

## Checklist — what's done vs left

**Done**
- [x] Static client-side PWA under ``, relative paths, SW scoped to the subpath.
- [x] `docs/.nojekyll` created.
- [x] Track Record panel: equity curve, win rate, avg win/loss, profit factor, per-strategy, best/worst — **reconciles to +$33,520.37 / 81.8% / 6.67 over 88 closed trades** (Feb–Jun 2026, verified headless in `js/repoint.test.mjs`). Honest range label on the panel + Weekly Card; sign/arrow glyph (▲/▼) on gains/losses for colorblind readability.
- [x] Live Book & Risk panel mirroring Ryan's 10-column sheet + Portfolio Summary (mix/risk donuts, BP gauges).
- [x] Weekly-monitor merge (Type E) — PRIMARY structured parser feeding the persistent position
      store. The staging preview + **Merge & refresh live book** button and the flagged-cell
      confirm queue now live **inline on the Import panel** (Monitor and Review are no longer
      separate tabs — the app is down to Track Record · Live Book · Import · Share). Live P/L
      Open shows as a column in the Live Book.
- [x] In-browser OCR (Tesseract.js) with layout detection, Type-A gridline segmentation, Type-B chain gating, ∞/bond-tick/crop handling.
- [x] Auto-derived Risk Type (validated vs Ryan's sheet), editable; Core/Supp editable.
- [x] Editable + localStorage-persistent; Reset-to-seed; CSV export.
- [x] **Capital Requirement CSV import** — drop tastytrade's BP/capital `.csv` export to fill per-position BP $/% (matched by underlying) and the portfolio BP Usage gauge, no OCR. Tolerant header-role detection + `$`/`(neg)`/`%` parsing; per-underlying totals attributed to a position only on a unique symbol match (multi-position symbols feed the summary total only). Verified headless in `js/capreq.test.mjs` (35 assertions).
- [x] Fee config (OFF by default, no-op).
- [x] manifest + service worker (app shell incl. all JS modules + Tesseract WASM/traineddata runtime cache). **Offline caveat (honest):** the ~12MB OCR engine is fetched from a CDN on first OCR and cached cache-first by the SW for offline use thereafter; a COLD first visit while offline cannot OCR. The SW caches the jsdelivr/wasm/`traineddata`/Tesseract CDN URLs on first use; `ensureTesseract` surfaces a clear "connect for your first OCR, then it works offline" message instead of a stack trace.
- [x] Privacy promise visible in the UI.
- [x] **Crop-thumbnail review loop** — flagged-only queue with source-pixel crops, validators (`min(OCR conf, validator)`, catches `1,250`→`1.250`), keyboard-first, severity buckets, provisional ribbon, blank-cell suppression. **Over-flagging fixed**: a passing validator is now trusted at a much lower OCR-conf gate (auto-accept >=50, was >=70), so a clean sheet flags a handful, not ~160 (simulated 150-cell clean sheet: 150 → 0; validator FAILS and <38-conf reads still flag). Verified in `js/repoint.test.mjs`.
- [x] **Weekly Card** — deterministic Canvas PNG (1600×900), handle hero, %-default / $-toggle, copy-to-clipboard + download, muted footer, persisted prefs. Verified headless ($-off vs $-on render differently; copy succeeds; console clean).
- [x] **JSON backup** — first-class export/import with `schemaVersion`, migration shim, >7-day nudge.
- [x] **BYOK vision accelerator (HYBRID)** — provider-agnostic adapter; OpenRouter (default) / OpenAI / Custom-local in one OpenAI-compatible path; opt-in, crop-only, key in sessionStorage, per-use consent; results re-enter the same validators + review item with human confirm. Verified headless: request shapes for all 3, key-never-in-localStorage, consent gate, and a mocked vision response flowing into the review item (re-validated).

**Left / honest caveats**
- [ ] **Browser-OCR character accuracy not benchmarked in CI** (no in-browser Tesseract in
      this environment). Segmentation/layout logic was validated against the real images;
      end-to-end read quality should be spot-checked by a human on first real use.
- [ ] **Type E (Monitor) is heuristic** — no fixed-grid parse; per-leg tree (underlying →
      strategy → legs) and futures micro-decimal marks are not fully structured yet.
- [ ] **Low-contrast Type-A sheets** (1 of 7 in the corpus) under-segment and flag rather
      than read. A future pass could fall back to OCR-word-cluster column inference.
- [ ] **Type B → row mapping is chain-total level**, not per-leg. It books the chain Total P/L
      (deduped cross-week by position key: ticker|strategy|P/L|close-date, so re-dropping the
      same CLSD chain never double-books). The unused per-leg `computeRealizedPnl` /
      `chainRealizedPnl` / `buildOccSymbol` ports were pruned this pass to cut surface area.
- [ ] **Type F fill tickets** intentionally unsupported (no computed P/L).
- [ ] **Capital Requirement CSV validated against header VARIANTS, not a captured export** —
      tastytrade's exact column names shift across platform versions, so the parser matches
      columns by fuzzy role (Requirement/Buying Power Effect, BP Usage %, Initial/Maintenance)
      and is tested against the shapes the docs describe. A real export should be spot-checked
      on first use; if a column is missed, the log says so rather than guessing. Per-underlying
      rows attach to a position only on a unique symbol match — symbols with several open
      positions feed the portfolio BP-usage total but aren't split across legs.
- [ ] **Weekly Card render is canvas, not html-to-image** — the brief suggested `html-to-image toPng`, but `chrome-headless-shell` drops its `<foreignObject>` HTML (only background/SVG rasterized → identical output regardless of content). Switched to a deterministic Canvas 2D render, which renders fully, validates headless, and works offline (no CDN). Same artifact, more robust path.
- [ ] **Review crops are session-only by design** — after a page reload the flag counts persist (metadata) but the crop image is gone (image bytes never stored). You can still edit/confirm from your own copy; the crop only shows during the import session.
- [ ] **BYOK adapters validated against MOCKS, not live APIs** — request construction, key handling, consent gate, and the mocked-response → review-item flow are verified headless; real calls to OpenRouter/OpenAI/your-local-endpoint need a one-time manual smoke (enable AI assist, paste a key or point at `http://localhost:11434/v1`, click "Read with AI" on a flagged cell). No network calls happen in CI.
- [ ] **Native Anthropic + Gemini adapters are stubs** — registry slots exist (disabled in the picker, "(next pass)"); their bespoke request/response shapes ship next pass. Selecting them throws a clear error rather than sending.
- [ ] **Whitelabel / rename deferred** (DECISION 2, next pass): no "LP Ledger" rebrand, brand-config abstraction, or "not affiliated with tastytrade" footer yet — current tastytrade-gold theme + naming kept, repo stays `tt-tracker`.
- [ ] Icons are generated placeholders (gold payoff mark on charcoal); swap for branded art if desired.

---

Built by Michael / Momentum Phinance. Seeded from Ryan LePiane's public LP Options Academy
weekly recaps. Educational only; not investment advice. Past performance ≠ future results.
