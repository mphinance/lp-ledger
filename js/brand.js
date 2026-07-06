// brand.js -- brand-config abstraction for white-label builds.
// Shape: { id, name, tagline, logoSrc, palette, fonts, card }
// To swap skins: change ACTIVE_BRAND below and reload. Zero other code changes required.

export const BRANDS = {

  // ---- LP Ledger (Ryan's brand) -- ACTIVE DEFAULT ---------------------------
  lpLedger: {
    id: 'lpLedger',
    name: 'LP Ledger',
    tagline: 'options track record · live book · on-device OCR',
    logoSrc: 'assets/lp-logo.png',

    palette: {
      // Surface: cream / off-white
      bg:       '#f4f2ec',
      bg2:      '#ede9e0',
      surface:  '#eae7de',
      surface2: '#e1ddd4',
      surface3: '#d8d4ca',
      line:     '#ccc9be',
      line2:    '#b8b5aa',
      // Ink: deep navy
      ink:      '#1b2a4a',
      ink2:     '#2d3e5e',
      muted:    '#7a7468',
      dim:      '#9d9890',
      // Data: vivid on cream (WCAG AA)
      pos:      '#1a7a4a',
      posDim:   'rgba(26,122,74,.14)',
      neg:      '#c0392b',
      negDim:   'rgba(192,57,43,.14)',
      // Accent: navy (replaces gold as chrome accent)
      accent:   '#1b2a4a',
      accentDim:'rgba(27,42,74,.12)',
      // Accent-on: text color used ON TOP of the accent swatch (white on navy)
      accentOn: '#ffffff',
      blue:     '#2c5fa8',
      violet:   '#6b4aac',
    },

    fonts: {
      // display: serif for h1/h2/brand name
      display: '"Playfair Display", Georgia, "Times New Roman", serif',
      // body: clean sans for UI text
      body:    'system-ui, -apple-system, "Segoe UI", sans-serif',
      // mono: tabular numerics
      mono:    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },

    // Dark variant of the LP Ledger skin -- deep navy surfaces + muted gold accent
    // (kept distinct from the neon "generic" terminal). Selected at runtime by the
    // theme toggle; falls back to `palette` for brands without a dark variant.
    darkPalette: {
      bg:       '#0c1020',
      bg2:      '#0f1426',
      surface:  '#151c30',
      surface2: '#1c2438',
      surface3: '#252f47',
      line:     '#2c3650',
      line2:    '#3c4767',
      ink:      '#eef1f7',
      ink2:     '#c4cddf',
      muted:    '#8a93a8',
      dim:      '#5f6a84',
      pos:      '#3ecf8e',
      posDim:   'rgba(62,207,142,.15)',
      neg:      '#f4707a',
      negDim:   'rgba(244,112,122,.15)',
      // Accent: muted gold reads on navy where the light skin's navy accent can't.
      accent:   '#d9b45c',
      accentDim:'rgba(217,180,92,.15)',
      accentOn: '#0c1020',
      blue:     '#5b8fd8',
      violet:   '#a487e6',
    },

    // Canvas-only palette (used by card.js -- CSS vars do not apply on <canvas>)
    card: {
      bg:      '#f4f2ec',
      surface: '#eae7de',
      ink:     '#1b2a4a',
      ink2:    '#2d3e5e',
      muted:   '#7a7468',
      dim:     '#9d9890',
      pos:     '#1a7a4a',
      neg:     '#c0392b',
      gold:    '#1b2a4a',   // "gold" slot = accent for canvas compat
      line:    '#ccc9be',
      footer:  'LP Ledger · built with mphinance',
    },
  },

  // ---- Generic / tastytrade-gold dark terminal (original skin) --------------
  generic: {
    id: 'generic',
    name: 'TT Tracker',
    tagline: 'options track record · live book · on-device OCR',
    logoSrc: null,   // uses the CSS-drawn chevron

    palette: {
      bg:       '#08080a',
      bg2:      '#0c0c0f',
      surface:  '#141417',
      surface2: '#1a1a1f',
      surface3: '#202027',
      line:     '#28282f',
      line2:    '#34343d',
      ink:      '#f2f3f5',
      ink2:     '#c7c9cf',
      muted:    '#82838d',
      dim:      '#5c5d66',
      pos:      '#27c19a',
      posDim:   'rgba(39,193,154,.14)',
      neg:      '#f6465c',
      negDim:   'rgba(246,70,92,.14)',
      accent:   '#ffcb05',
      accentDim:'rgba(255,203,5,.12)',
      accentOn: '#0a0a0b',  // dark text on gold
      blue:     '#4a90e2',
      violet:   '#9b6bff',
    },

    fonts: {
      display: '"Archivo", system-ui, -apple-system, sans-serif',
      body:    '"Archivo", system-ui, -apple-system, sans-serif',
      mono:    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },

    card: {
      bg:      '#0a0a0b',
      surface: '#141417',
      ink:     '#f2f3f5',
      ink2:    '#c7c9cf',
      muted:   '#82838d',
      dim:     '#5c5d66',
      pos:     '#27c19a',
      neg:     '#f6465c',
      gold:    '#ffcb05',
      line:    '#28282f',
      footer:  'tt-tracker · mphinance',
    },
  },
};

// Change this constant to 'generic' to restore the original dark terminal look.
// No other code changes are required to swap skins.
export const ACTIVE_BRAND = 'lpLedger';

export function getBrand(id) {
  return BRANDS[id] || BRANDS.lpLedger;
}

/** Apply a brand preset: sets CSS custom properties on :root + data-brand attr.
 *  `mode` ('light' | 'dark') selects the palette variant; a brand without a
 *  darkPalette falls back to its default palette (so the toggle is a no-op there).
 *  Also stamps data-theme on <html> for the CSS overrides that vars can't reach. */
export function applyBrand(brand, mode = 'light') {
  const r = document.documentElement;
  const p = (mode === 'dark' && brand.darkPalette) ? brand.darkPalette : brand.palette;
  const f = brand.fonts;

  // Palette
  r.style.setProperty('--bg',         p.bg);
  r.style.setProperty('--bg2',        p.bg2);
  r.style.setProperty('--surface',    p.surface);
  r.style.setProperty('--surface2',   p.surface2);
  r.style.setProperty('--surface3',   p.surface3);
  r.style.setProperty('--line',       p.line);
  r.style.setProperty('--line2',      p.line2);
  r.style.setProperty('--ink',        p.ink);
  r.style.setProperty('--ink2',       p.ink2);
  r.style.setProperty('--muted',      p.muted);
  r.style.setProperty('--dim',        p.dim);
  r.style.setProperty('--pos',        p.pos);
  r.style.setProperty('--pos-dim',    p.posDim);
  r.style.setProperty('--neg',        p.neg);
  r.style.setProperty('--neg-dim',    p.negDim);
  r.style.setProperty('--gold',       p.accent);
  r.style.setProperty('--gold-dim',   p.accentDim);
  r.style.setProperty('--accent-on',  p.accentOn);
  r.style.setProperty('--blue',       p.blue);
  r.style.setProperty('--violet',     p.violet);

  // Fonts
  r.style.setProperty('--sans',       f.body);
  r.style.setProperty('--display',    f.display);
  r.style.setProperty('--mono',       f.mono);

  // Brand marker -- CSS [data-brand="lpLedger"] selectors key off this
  r.dataset.brand = brand.id;
  // Theme marker -- CSS [data-theme="dark"] overrides key off this
  r.dataset.theme = (mode === 'dark' && brand.darkPalette) ? 'dark' : 'light';

  // DOM chrome
  const nameEl    = document.getElementById('brand-name');
  const taglineEl = document.getElementById('brand-tagline');
  const logoImg   = document.getElementById('brand-logo');
  const logoCss   = document.getElementById('logo-css');

  if (nameEl)    nameEl.textContent    = brand.name.toUpperCase();
  if (taglineEl) taglineEl.textContent = brand.tagline;

  if (brand.logoSrc && logoImg) {
    logoImg.src = brand.logoSrc;
    logoImg.alt = brand.name + ' logo';
  }

  // Title
  document.title = brand.name + ' — options track record & live book';
}

/** Preload the brand logo as an HTMLImageElement (for canvas use in card.js). */
export function loadLogoImage(brand) {
  if (!brand.logoSrc) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = brand.logoSrc;
  });
}
