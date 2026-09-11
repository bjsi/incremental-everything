// lib/priority_history.ts
//
// The shared vocabulary for "why did this priority change?", and the whole
// read/write path for the CardPriority `History` slot.
//
// TWO HISTORIES, ONE VOCABULARY
//
// An Incremental Rem already had a history: the `IncrementalRep[]` in its
// `History` slot, which several writers (reschedule, editor review, the
// interval batch save) stamp with the priority they just set. What it lacked
// was an entry for the changes that touch ONLY the priority — the Alt+P popup,
// Quick Priority, the inline editors — so those changes left no trace at all.
// Those now append an entry with `eventType: 'priorityChange'`.
//
// A CardPriority rem had no history whatsoever. It gets one here, in its own
// hidden slot, as a compact array of {t,p,s,e} records.
//
// Both sides describe the CAUSE with the same {@link PriorityChangeEvent}
// codes, so the two popups can render the same labels and a reader comparing
// them is not learning two vocabularies.
//
// WHY THE ENTRIES ARE SO SMALL
//
// These live in a powerup slot, i.e. inside the Rem, and a Rem that grows past
// RemNote's per-document sync ceiling stops syncing (that is the failure the
// debug tools' "too large to sync" locator hunts for). A priority can be nudged
// dozens of times in a session, so the record has to stay cheap: four short
// keys, no prose, a hard entry cap, and coalescing so a burst of ±10 taps
// leaves ONE row rather than eight.

import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { CARD_PRIORITY_CODE, PrioritySource } from './card_priority/types';

/**
 * The CardPriority slot holding the priority history, as serialized JSON.
 *
 * A NEW slot code, registered hidden + programmatic-only, which is what makes
 * it hidden in EXISTING knowledge bases too: RemNote applies slot options when
 * the definition Rem is created and never mutates an existing one, so only a
 * code that has no Rem anywhere can be introduced hidden. Same reasoning that
 * put the priority VALUE in `priorityValue` — see card_priority/slot_access.ts.
 */
export const PRIORITY_HISTORY_SLOT = 'priorityHistory';

/**
 * What the user (or the plugin) did to cause a priority change.
 *
 * Kept deliberately coarse: the point is to answer "was this me, or the
 * plugin?" and "which gesture was it?", not to name the call site. Every writer
 * of either priority maps onto one of these — see PRIORITY_EVENT_LABELS for the
 * full list as the user sees it.
 */
export type PriorityChangeEvent =
  /** The rem was tagged and given its first priority. */
  | 'tagged'
  /** The Priority popup (Alt+P), single-rem or batch. */
  | 'popup'
  /** Quick Priority (Ctrl+Opt+↑/↓) and the Priority Editor's ± buttons. */
  | 'quick'
  /** An inline priority edit in a list view (IncRem list, main view, page range). */
  | 'editor'
  /** One of the batch priority tools. */
  | 'batch'
  /** The Priority & Interval batch save. */
  | 'interval'
  /** A reschedule (Ctrl+J), in the queue or the editor. */
  | 'reschedule'
  /** A review that also set a priority (editor review, review timer, queue). */
  | 'review'
  /** Adopted from this rem's own Incremental priority. */
  | 'incremental'
  /** Inherited from the closest ancestor carrying a priority. */
  | 'inherited'
  /** The configured default, assigned because nothing else applied. */
  | 'default'
  /** An inheritance cascade re-applied an ancestor's priority downwards. */
  | 'cascade'
  /** The Mastery Drill's priority editor. */
  | 'drill'
  /** The Card Enablement tool assigning a priority as it re-enables cards. */
  | 'enablement'
  /** Splitting a cloze into its own rem carried a priority across. */
  | 'cloze'
  /** An import (study log, incremental history). */
  | 'import'
  /** A maintenance/repair pass writing a value back into a healthy slot. */
  | 'repair'
  /** Anything not otherwise mapped. */
  | 'other';

/** Human labels, shared by the flashcard and incremental history popups. */
export const PRIORITY_EVENT_LABELS: Record<PriorityChangeEvent, string> = {
  tagged: 'Initial assignment',
  popup: 'Priority popup',
  quick: 'Quick priority change',
  editor: 'Inline edit',
  batch: 'Batch priority',
  interval: 'Priority & interval',
  reschedule: 'Reschedule',
  review: 'Review',
  incremental: 'From Incremental Rem',
  inherited: 'Inherited from ancestor',
  default: 'Default priority',
  cascade: 'Inheritance cascade',
  drill: 'Mastery drill',
  enablement: 'Card enablement',
  cloze: 'Cloze split',
  import: 'Import',
  repair: 'Slot repair',
  other: 'Other',
};

/** Small glyph per event, so a long list is scannable without reading labels. */
export const PRIORITY_EVENT_ICONS: Record<PriorityChangeEvent, string> = {
  tagged: '🏷',
  popup: '⌨️',
  quick: '⚡',
  editor: '✏️',
  batch: '📦',
  interval: '📐',
  reschedule: '📅',
  review: '📖',
  incremental: '♾',
  inherited: '⬇',
  default: '•',
  cascade: '🌊',
  drill: '🎯',
  enablement: '🃏',
  cloze: '✂️',
  import: '📥',
  repair: '🛠',
  other: '·',
};

export function priorityEventLabel(event: string | undefined): string {
  if (!event) return PRIORITY_EVENT_LABELS.other;
  return PRIORITY_EVENT_LABELS[event as PriorityChangeEvent] ?? event;
}

export function priorityEventIcon(event: string | undefined): string {
  if (!event) return PRIORITY_EVENT_ICONS.other;
  return PRIORITY_EVENT_ICONS[event as PriorityChangeEvent] ?? PRIORITY_EVENT_ICONS.other;
}

/**
 * Source-derived default event, for writers that have not been given one.
 *
 * The three derivable sources describe their own cause exactly, so they need no
 * separate event; only 'manual' is ambiguous, and every manual writer passes an
 * explicit event.
 */
export function defaultEventForSource(source: PrioritySource): PriorityChangeEvent {
  switch (source) {
    case 'incremental':
      return 'incremental';
    case 'inherited':
      return 'inherited';
    case 'default':
      return 'default';
    default:
      return 'other';
  }
}

/** One stored change. Short keys — this lives inside the Rem. */
export interface PriorityHistoryEntry {
  /** When the change was written (epoch ms). */
  t: number;
  /** The priority written (0–100). */
  p: number;
  /** The source recorded alongside it. */
  s: PrioritySource;
  /** What caused it. */
  e: PriorityChangeEvent;
}

/**
 * Successive changes from the SAME gesture inside this window collapse into one
 * entry. Quick Priority is the reason: holding Ctrl+Opt+↓ to walk a priority
 * from 80 to 30 is one decision, and recording eight rows for it would bury the
 * decisions either side of it.
 */
export const PRIORITY_HISTORY_COALESCE_MS = 60_000;

/**
 * Hard cap on stored entries. The FIRST entry is always kept — it is the origin
 * of the priority and the one row that cannot be reconstructed from anything
 * else — and the newest (cap − 1) follow it.
 */
export const PRIORITY_HISTORY_MAX_ENTRIES = 150;

/** Tolerant parse: anything unreadable is treated as "no history yet". */
export function parsePriorityHistory(raw: unknown): PriorityHistoryEntry[] {
  const text =
    typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : '';
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PriorityHistoryEntry =>
        !!x && typeof x.t === 'number' && typeof x.p === 'number'
    );
  } catch {
    return [];
  }
}

/**
 * Fold a change into an existing history.
 *
 * Returns `null` when there is nothing to record, which is the common case on
 * the automatic paths: a cascade or a cache rebuild re-writes the same value
 * and source it wrote last time, and that must not produce a row.
 *
 * The two rules:
 *  - IDENTICAL — same priority AND same source as the newest entry: skip.
 *  - COALESCE — same event as the newest entry, within
 *    {@link PRIORITY_HISTORY_COALESCE_MS}: replace it, so a burst of taps
 *    leaves one row carrying the value it settled on.
 *
 * Coalescing keys on the event, so it can never swallow a different kind of
 * change that happened to land in the same minute — a Quick Priority tap
 * seconds after the initial tagging appends, it does not overwrite the 'tagged'
 * row.
 */
export function foldPriorityHistory(
  history: PriorityHistoryEntry[],
  entry: PriorityHistoryEntry
): PriorityHistoryEntry[] | null {
  const last = history[history.length - 1];

  if (last && last.p === entry.p && last.s === entry.s) return null;

  const coalesce =
    last && last.e === entry.e && entry.t - last.t <= PRIORITY_HISTORY_COALESCE_MS;

  const next = coalesce ? [...history.slice(0, -1), entry] : [...history, entry];
  return trimPriorityHistory(next);
}

/** Keeps the origin entry plus the newest (cap − 1). */
export function trimPriorityHistory(history: PriorityHistoryEntry[]): PriorityHistoryEntry[] {
  if (history.length <= PRIORITY_HISTORY_MAX_ENTRIES) return history;
  return [history[0], ...history.slice(history.length - (PRIORITY_HISTORY_MAX_ENTRIES - 1))];
}

// ── CardPriority slot I/O ───────────────────────────────────────────────────

/** The stored history for a rem, oldest first. Empty when there is none. */
export async function readCardPriorityHistory(rem: PluginRem): Promise<PriorityHistoryEntry[]> {
  try {
    return parsePriorityHistory(
      await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_HISTORY_SLOT)
    );
  } catch {
    return [];
  }
}

export interface RecordCardPriorityChangeOptions {
  priority: number;
  source: PrioritySource;
  event: PriorityChangeEvent;
  /**
   * Whether the rem already carried the CardPriority powerup BEFORE this write.
   *
   * `false` means it cannot have a history, which lets the append skip its read
   * — the point being that a first-time bulk assignment (the KB-wide
   * inherited/default index) is the one path where the extra round trip per rem
   * would actually be felt.
   */
  hadPowerup: boolean;
  /** Timestamp of the change; defaults to now. */
  at?: number;
}

/**
 * Appends a change to a rem's CardPriority history.
 *
 * Never throws: the history is a record OF a write that has already succeeded,
 * and losing a row must not cost the caller the priority it just set.
 */
export async function recordCardPriorityChange(
  rem: PluginRem,
  options: RecordCardPriorityChangeOptions
): Promise<void> {
  try {
    const entry: PriorityHistoryEntry = {
      t: options.at ?? Date.now(),
      p: options.priority,
      s: options.source,
      e: options.event,
    };
    const existing = options.hadPowerup ? await readCardPriorityHistory(rem) : [];
    const next = foldPriorityHistory(existing, entry);
    if (!next) return;
    await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_HISTORY_SLOT, [
      JSON.stringify(next),
    ]);
  } catch (err) {
    console.error('[PriorityHistory] failed to record a card priority change', err);
  }
}

/** Clears the stored history. Used when the tag is stripped from a rem. */
export async function clearCardPriorityHistory(rem: PluginRem): Promise<void> {
  try {
    await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_HISTORY_SLOT, []);
  } catch {
    /* the slot may not resolve on this rem; nothing to clear then */
  }
}

// ── Aggregates for the popups ───────────────────────────────────────────────

export interface PriorityHistorySummary {
  entries: PriorityHistoryEntry[];
  first: PriorityHistoryEntry | null;
  last: PriorityHistoryEntry | null;
  /** Lowest and highest priority ever recorded. */
  min: number | null;
  max: number | null;
  /** How many entries came from a deliberate user gesture. */
  manualCount: number;
}

const MANUAL_EVENTS: ReadonlySet<PriorityChangeEvent> = new Set<PriorityChangeEvent>([
  'popup',
  'quick',
  'editor',
  'batch',
  'interval',
  'reschedule',
  'drill',
]);

export function summarizePriorityHistory(
  entries: PriorityHistoryEntry[]
): PriorityHistorySummary {
  if (entries.length === 0) {
    return { entries, first: null, last: null, min: null, max: null, manualCount: 0 };
  }
  let min = entries[0].p;
  let max = entries[0].p;
  let manualCount = 0;
  for (const e of entries) {
    if (e.p < min) min = e.p;
    if (e.p > max) max = e.p;
    if (MANUAL_EVENTS.has(e.e)) manualCount++;
  }
  return {
    entries,
    first: entries[0],
    last: entries[entries.length - 1],
    min,
    max,
    manualCount,
  };
}
