import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { powerupCode, dismissedPowerupCode, pdfStateSlotCode } from './consts';

// --- legacy synced keys ----------------------------------------------------
// Defined here rather than in pdfUtils so this module has no dependency on it
// (pdfUtils imports this one). pdfUtils re-exports them for existing callers,
// notably the storage audit, which still needs to probe for them.

export const getCurrentPageKey = (incrementalRemId: string, pdfRemId: string) =>
  `incremental_current_page_${incrementalRemId}_${pdfRemId}`;

export const getPageRangeKey = (incrementalRemId: string, pdfRemId: string) =>
  `incremental_page_range_${incrementalRemId}_${pdfRemId}`;

export const getPageHistoryKey = (incrementalRemId: string, pdfRemId: string) =>
  `incremental_page_history_${incrementalRemId}_${pdfRemId}`;

export const getActivePdfKey = (incRemId: string) => `active_pdf_for_${incRemId}`;

// ---------------------------------------------------------------------------
// PDF reading state — stored on the Rem, not in plugin storage
//
// Four synced-key families used to hold this, one key per (IncRem, PDF) pair
// plus one per IncRem:
//
//   incremental_current_page_<incRemId>_<pdfRemId>
//   incremental_page_range_<incRemId>_<pdfRemId>
//   incremental_page_history_<incRemId>_<pdfRemId>
//   active_pdf_for_<incRemId>
//
// That is the family that scales fastest with use — three keys for every chapter
// of every book — and plugin storage has no deletion API, so deleting a chapter
// left its keys behind permanently. The state is also, plainly, about the Rem.
//
// It now lives in one hidden slot as versioned JSON:
//
//   { v: 1, active?: pdfRemId, bySource: { [pdfRemId]: { page, range, history } } }
//
// One property per Rem regardless of how many PDFs it draws on, deleted with the
// Rem, and carried through dismissal (see transferPdfState). Reads fall back to
// the legacy keys and migrate that pair on the way past — no bulk pass.
//
// The slot exists on BOTH the Incremental and Dismissed powerups. Dismissing a
// Rem removes the Incremental powerup, which would take the state with it, so
// the dismissal path copies the serialized string across and the re-activation
// path copies it back. Same shape on both sides makes that a string copy rather
// than a parse/transform.
// ---------------------------------------------------------------------------

export interface PageHistoryEntry {
  page?: number;
  timestamp: number;
  sessionDuration?: number;
  highlightId?: string;
}

export interface PdfSourceState {
  page?: number;
  range?: { start: number; end: number };
  history?: PageHistoryEntry[];
}

export interface PdfState {
  v: 1;
  /** The PDF pinned as active for this Rem, when it has several sources. */
  active?: string;
  bySource: Record<string, PdfSourceState>;
}

const EMPTY: PdfState = { v: 1, bySource: {} };

/** Page history is capped at this many entries per source, as it was under the
 *  old per-pair key. A Rem reading several PDFs holds one capped list each. */
export const PAGE_HISTORY_LIMIT = 100;

// --- powerup resolution ----------------------------------------------------

/** Which powerup currently carries this Rem's state. A Rem is Incremental or
 *  Dismissed, never both in normal operation; Incremental wins if both are
 *  somehow present, since that is the live one. */
async function resolveStateHost(rem: PluginRem): Promise<string | null> {
  try {
    if (await rem.hasPowerup(powerupCode)) return powerupCode;
    if (await rem.hasPowerup(dismissedPowerupCode)) return dismissedPowerupCode;
  } catch {
    /* fall through */
  }
  return null;
}

// --- serialization ---------------------------------------------------------

function parseState(raw: unknown): PdfState | null {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { v: 1, active: parsed.active, bySource: parsed.bySource || {} };
  } catch {
    return null;
  }
}

/** Reads the raw serialized state string, or null. Used by the dismissal
 *  transfer, which moves the value without needing to understand it. */
export async function readRawPdfState(
  rem: PluginRem,
  powerup: string
): Promise<string | null> {
  try {
    const raw = await rem.getPowerupProperty(powerup, pdfStateSlotCode);
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
}

export async function writeRawPdfState(
  rem: PluginRem,
  powerup: string,
  raw: string
): Promise<void> {
  await rem.setPowerupProperty(powerup, pdfStateSlotCode, [raw]);
}

// --- legacy migration ------------------------------------------------------

/**
 * Pulls whatever the legacy synced keys hold for one (Rem, PDF) pair.
 *
 * Returns null when there is nothing stored, so a Rem that never had legacy data
 * is not written back for no reason. The legacy keys are left in place: plugin
 * storage cannot delete a key, and writing null does not free the slot, so they
 * wait for the ledger sweep (STORAGE_PLAN.md Phase 7).
 */
async function readLegacyPair(
  plugin: RNPlugin,
  remId: string,
  pdfRemId: string
): Promise<PdfSourceState | null> {
  const [page, range, history] = await Promise.all([
    plugin.storage.getSynced(getCurrentPageKey(remId, pdfRemId)),
    plugin.storage.getSynced(getPageRangeKey(remId, pdfRemId)),
    plugin.storage.getSynced(getPageHistoryKey(remId, pdfRemId)),
  ]);

  const state: PdfSourceState = {};
  if (typeof page === 'number') state.page = page;
  if (range && typeof range === 'object' && 'start' in (range as any)) {
    state.range = range as { start: number; end: number };
  }
  if (Array.isArray(history)) {
    const normalized = normalizeHistory(history);
    if (normalized.length > 0) state.history = normalized;
  }

  return Object.keys(state).length > 0 ? state : null;
}

/** Accepts both historical history shapes: a bare array of page numbers, and
 *  the later entry objects. Entries with neither a page nor a highlightId are
 *  dropped, matching the previous reader's behaviour. */
export function normalizeHistory(raw: unknown): PageHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) => {
      if (typeof entry === 'number') return { page: entry, timestamp: 0 };
      if (entry && (typeof entry.page === 'number' || entry.highlightId)) {
        return {
          page: typeof entry.page === 'number' ? entry.page : undefined,
          timestamp: entry.timestamp || 0,
          sessionDuration: entry.sessionDuration,
          highlightId: entry.highlightId,
        };
      }
      return null;
    })
    .filter(Boolean) as PageHistoryEntry[];
}

// --- load / save -----------------------------------------------------------

export interface LoadedPdfState {
  rem: PluginRem | null;
  powerup: string | null;
  state: PdfState;
}

/**
 * Loads a Rem's PDF state, migrating the legacy keys for `pdfRemId` if the
 * property does not cover that source yet.
 *
 * Pass `pdfRemId` when the caller is working with a specific source — migration
 * is per-pair, because the legacy key names cannot be enumerated without knowing
 * both ids. Omit it to read whatever the property already holds.
 */
export async function loadPdfState(
  plugin: RNPlugin,
  remId: string,
  pdfRemId?: string
): Promise<LoadedPdfState> {
  let rem: PluginRem | null = null;
  try {
    rem = (await plugin.rem.findOne(remId)) ?? null;
  } catch {
    rem = null;
  }

  const powerup = rem ? await resolveStateHost(rem) : null;
  let state: PdfState = { v: 1, bySource: {} };

  if (rem && powerup) {
    const parsed = parseState(await readRawPdfState(rem, powerup));
    if (parsed) state = parsed;
  }

  // Legacy fallback, for this source only.
  if (pdfRemId && !state.bySource[pdfRemId]) {
    const legacy = await readLegacyPair(plugin, remId, pdfRemId);
    if (legacy) {
      state.bySource[pdfRemId] = legacy;
      if (rem && powerup) {
        try {
          await writeRawPdfState(rem, powerup, JSON.stringify(state));
          console.log(`[PdfState] Migrated legacy reading state for ${remId} / ${pdfRemId} onto the Rem.`);
        } catch (err) {
          console.warn('[PdfState] Migration write failed; using the legacy value', err);
        }
      }
    }
  }

  // The active PDF lived in its own per-Rem key.
  if (state.active === undefined) {
    try {
      const legacyActive = await plugin.storage.getSynced<string>(getActivePdfKey(remId));
      if (typeof legacyActive === 'string' && legacyActive) state.active = legacyActive;
    } catch {
      /* ignore */
    }
  }

  return { rem, powerup, state };
}

/** Persists a state object. A Rem with neither powerup cannot hold it — that
 *  happens transiently while a Rem is being converted, and losing a page
 *  position there is preferable to writing a property onto an untagged Rem. */
export async function savePdfState(loaded: LoadedPdfState): Promise<boolean> {
  const { rem, powerup, state } = loaded;
  if (!rem || !powerup) return false;
  try {
    await writeRawPdfState(rem, powerup, JSON.stringify(state));
    return true;
  } catch (err) {
    console.warn('[PdfState] Write failed', err);
    return false;
  }
}

/** Read-modify-write for one source's slice of the state. */
export async function updateSourceState(
  plugin: RNPlugin,
  remId: string,
  pdfRemId: string,
  mutate: (current: PdfSourceState) => PdfSourceState
): Promise<void> {
  const loaded = await loadPdfState(plugin, remId, pdfRemId);
  const current = loaded.state.bySource[pdfRemId] || {};
  loaded.state.bySource[pdfRemId] = mutate({ ...current });
  await savePdfState(loaded);
}

// --- dismissal transfer ----------------------------------------------------

/**
 * Moves the serialized state between the Incremental and Dismissed powerups.
 *
 * Dismissal removes the Incremental powerup, so this must run BEFORE that
 * removal; re-activation adds the Incremental powerup, so it must run AFTER.
 * Both powerups use the same slot code and the same shape, so nothing is parsed.
 *
 * When the target already holds state (a Rem dismissed, revived and dismissed
 * again), the two are merged per source with the incoming — more recent —
 * value winning, rather than one silently replacing the other.
 */
export async function transferPdfState(
  rem: PluginRem,
  fromPowerup: string,
  toPowerup: string
): Promise<boolean> {
  const incoming = await readRawPdfState(rem, fromPowerup);
  if (!incoming) return false;

  const existing = await readRawPdfState(rem, toPowerup);
  if (!existing) {
    await writeRawPdfState(rem, toPowerup, incoming);
    return true;
  }

  const a = parseState(existing) ?? EMPTY;
  const b = parseState(incoming) ?? EMPTY;
  const merged: PdfState = {
    v: 1,
    active: b.active ?? a.active,
    bySource: { ...a.bySource, ...b.bySource },
  };
  await writeRawPdfState(rem, toPowerup, JSON.stringify(merged));
  return true;
}
