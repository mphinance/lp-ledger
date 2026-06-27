// backup.js — first-class JSON export/import (the account + cross-device path).
// Round-trips the full state with a schemaVersion stamp. CSV stays for build.py
// interop; JSON is the lossless backup. Nudges a backup if the last one is >7d old.

export const SCHEMA_VERSION = 2;
const LAST_BACKUP_KEY = "tt-tracker-last-backup";

export function exportJson(state) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: "tt-tracker",
    state: {
      trades: state.trades,
      openBook: state.openBook,
      summary: state.summary,
      monitor: state.monitor,
      pendingTickets: state.pendingTickets || [],
      fees: state.fees,
      review: (state.review || []).map(stripCrop), // metadata only; no image bytes
      cardPrefs: state.cardPrefs || null,
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tt-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  markBackup();
}

// returns { ok, state?, error?, warning? }
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, error: "Not valid JSON." }; }
  if (!data || data.app !== "tt-tracker" || !data.state) return { ok: false, error: "Not a tt-tracker backup file." };
  let warning = null;
  if (data.schemaVersion !== SCHEMA_VERSION) {
    warning = `Backup schemaVersion ${data.schemaVersion} vs app ${SCHEMA_VERSION} — imported with best-effort migration.`;
  }
  const s = data.state;
  // migration shim: ensure required arrays exist
  const migrated = {
    trades: Array.isArray(s.trades) ? s.trades : [],
    openBook: Array.isArray(s.openBook) ? s.openBook : [],
    summary: s.summary || {},
    monitor: Array.isArray(s.monitor) ? s.monitor : [],
    pendingTickets: Array.isArray(s.pendingTickets) ? s.pendingTickets : [],
    fees: s.fees || { enabled: false, perContractOpen: 1, perContractClose: 0, clearingReg: 0.15 },
    review: Array.isArray(s.review) ? s.review : [],
    cardPrefs: s.cardPrefs || null,
  };
  return { ok: true, state: migrated, warning };
}

export function readFileText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsText(file);
  });
}

export function markBackup() { try { localStorage.setItem(LAST_BACKUP_KEY, Date.now().toString()); } catch (e) {} }
export function daysSinceBackup() {
  const t = Number(localStorage.getItem(LAST_BACKUP_KEY) || 0);
  if (!t) return Infinity;
  return (Date.now() - t) / 86400000;
}
export function shouldNudge() { return daysSinceBackup() > 7; }

function stripCrop(item) {
  // keep value/bbox/severity metadata; never carries image bytes anyway.
  const { ...rest } = item;
  return rest;
}
