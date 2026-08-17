// lib/card_priority/slot_access.ts
//
// The single place the CardPriority priority VALUE is read and written.
//
// WHY THIS MODULE EXISTS
//
// The priority used to live in one slot, `priority`, registered VISIBLE. A
// visible slot materialises a property CHILD rem under every tagged rem, and
// that child is what breaks RemNote tables: when the tagged rem is itself a
// table cell (a filled tag slot), the cell renderer switches to list mode and
// paints the child — "Priority — 31" — in place of the cell's own value, which
// it then never emits at all. Confirmed in both table renderers: simple tables
// (`table_cell_list-*` + `data-rem-container-property="priority"`) and advanced
// tables (an `alternative-denomination-` property cell tagged cardpriority
// rendered as `tree-node--table-cell-list` with its value gone).
//
// A hidden slot has no such child — see the note in lib/powerup_slot_compat.ts:
// "hidden-slot VALUES no longer live in a child Rem of the tagged rem (a rem
// with History and Created set can have zero property children), while
// visible-slot values still do."
//
// PRIORITY_SLOT cannot simply be re-registered hidden: RemNote applies slot
// options when the slot definition rem is CREATED and does not mutate an
// existing one, so only brand-new knowledge bases would change (measured — see
// register/powerups.tsx). So the value moves to a NEW hidden slot,
// PRIORITY_VALUE_SLOT, whose definition rem does not exist yet in any KB and is
// therefore created hidden everywhere.
//
// THE TWO-SLOT WINDOW
//
// Until a KB is migrated it has values in the visible slot, written by every
// earlier version of the plugin and hand-editable in the outline. So:
//
//   READ  — hidden first, visible as fallback. Both are fetched in ONE
//           Promise.all so the extra call costs no wall-clock time (the same
//           reasoning getCardPriority already documents for its three reads).
//   WRITE — hidden ALWAYS; visible too, but only while this KB is
//           un-migrated. Dropping the visible write before migration would
//           silently break hand edits of the Priority row: the row would still
//           be there, still editable, and simply ignored on the next read.
//
// After migration the visible write stops and the visible children are gone, so
// hand-editing a priority in the outline is no longer possible — the Priority
// popup, Quick Priority and the batch tools are the way in. That is the trade
// the migration dialog states out loud.
//
// The migrated flag is per-KB in SYNCED storage: the migration is a change to
// the knowledge base itself, so a phone that syncs it must stop writing the
// visible slot too, or it would recreate exactly the children the migration
// removed.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { cardPriorityHiddenSlotStateKey } from '../consts';
import {
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  PRIORITY_VALUE_SLOT,
} from './types';

/** Which slot a value was actually found in. */
export type PrioritySlotOrigin = 'hidden' | 'visible' | null;

export interface RawPriorityRead {
  /** The raw slot string, or null when neither slot holds a value. */
  value: string | null;
  origin: PrioritySlotOrigin;
  /** Set when the visible slot ALSO holds a value — i.e. this rem is not yet
   *  migrated, whatever the KB-level flag says. */
  visibleValue: string | null;
}

// ── Migration state ─────────────────────────────────────────────────────────

export interface HiddenSlotMigrationRecord {
  /** When the migration completed. Absent while un-migrated. */
  migratedAt?: number;
  /** Rems whose value was moved, from the run that set migratedAt. */
  moved?: number;
  /** Visible property children deleted by that run. */
  childrenRemoved?: number;
  /** Set when the user chose "never ask again" on the startup offer. */
  offerSuppressed?: boolean;
  /** Last time the startup offer was shown, for the log. */
  lastOfferedAt?: number;
}

type HiddenSlotMigrationState = Record<string, HiddenSlotMigrationRecord>;

/**
 * Session memo of the knowledge base id.
 *
 * Memoised because {@link isHiddenSlotMigrated} is consulted by EVERY priority
 * write, and a bulk pass writes tens of thousands of them — resolving the id
 * afresh each time would add an IPC round trip per rem to the heaviest thing the
 * plugin does. RemNote gives each knowledge base its own plugin instance, so the
 * id cannot change under a session; and if that ever stopped being true, the cost
 * is bounded — the wrong answer only decides whether the visible slot is written
 * alongside the hidden one, which the next migration run reconciles.
 */
let kbIdMemo: string | null = null;

export async function currentKbId(plugin: RNPlugin): Promise<string | null> {
  if (kbIdMemo) return kbIdMemo;
  try {
    kbIdMemo = (await plugin.kb.getCurrentKnowledgeBaseData())?._id ?? null;
    return kbIdMemo;
  } catch {
    return null;
  }
}

async function readState(plugin: RNPlugin): Promise<HiddenSlotMigrationState> {
  return (
    (await plugin.storage.getSynced<HiddenSlotMigrationState>(
      cardPriorityHiddenSlotStateKey
    )) || {}
  );
}

export async function readHiddenSlotRecord(
  plugin: RNPlugin
): Promise<HiddenSlotMigrationRecord | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;
  return (await readState(plugin))[kbId] ?? null;
}

/** Read-modify-write of this KB's slice only — the key is shared by every KB. */
export async function patchHiddenSlotRecord(
  plugin: RNPlugin,
  patch: Partial<HiddenSlotMigrationRecord>
): Promise<void> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  const state = await readState(plugin);
  state[kbId] = { ...(state[kbId] || {}), ...patch };
  await plugin.storage.setSynced(cardPriorityHiddenSlotStateKey, state);
  migratedFlagMemo = { kbId, migrated: !!state[kbId].migratedAt };
}

/**
 * Session memo of the flag, because every priority write consults it. The
 * migration and the undo both refresh it through patchHiddenSlotRecord /
 * clearHiddenSlotMigrationFlag, so it cannot go stale within a session; a
 * migration run on ANOTHER device lands on the next launch, and until then that
 * device merely keeps writing a visible slot the migration already emptied,
 * which the next run cleans up.
 */
let migratedFlagMemo: { kbId: string; migrated: boolean } | null = null;

export async function isHiddenSlotMigrated(plugin: RNPlugin): Promise<boolean> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return false;
  if (migratedFlagMemo?.kbId === kbId) return migratedFlagMemo.migrated;
  const migrated = !!(await readState(plugin))[kbId]?.migratedAt;
  migratedFlagMemo = { kbId, migrated };
  return migrated;
}

export async function clearHiddenSlotMigrationFlag(plugin: RNPlugin): Promise<void> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return;
  const state = await readState(plugin);
  if (state[kbId]) {
    delete state[kbId].migratedAt;
    delete state[kbId].moved;
    delete state[kbId].childrenRemoved;
    await plugin.storage.setSynced(cardPriorityHiddenSlotStateKey, state);
  }
  migratedFlagMemo = { kbId, migrated: false };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The raw priority string for a rem, from whichever slot holds it.
 *
 * Hidden wins over visible. On a migrated KB the visible slot is empty anyway;
 * on an un-migrated one both are written, so they agree — and if they ever
 * disagree, the hidden slot is the one the plugin wrote last.
 */
export async function readRawCardPriority(rem: PluginRem): Promise<RawPriorityRead> {
  const [hidden, visible] = await Promise.all([
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT).catch(() => null),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null),
  ]);
  const hiddenValue = hidden || null;
  const visibleValue = visible || null;
  return {
    value: hiddenValue ?? visibleValue,
    origin: hiddenValue ? 'hidden' : visibleValue ? 'visible' : null,
    visibleValue,
  };
}

/**
 * Convenience wrapper for the many callers that only want the string.
 *
 * Returns '' rather than null when nothing is set, matching what
 * getPowerupProperty returned at the call sites this replaced — several of them
 * test the result for truthiness and nothing more.
 */
export async function getRawCardPriorityString(rem: PluginRem): Promise<string> {
  return (await readRawCardPriority(rem)).value ?? '';
}

/**
 * The two reads that {@link readRawCardPriority} would do, exposed so callers
 * already running a Promise.all over several slots can fold them into it rather
 * than paying a second round trip. Pass the results to
 * {@link resolveRawCardPriority}.
 */
export function rawCardPriorityReads(rem: PluginRem): [Promise<string | undefined | null>, Promise<string | undefined | null>] {
  return [
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT).catch(() => null),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null),
  ];
}

/** Picks the winner from the pair returned by {@link rawCardPriorityReads}. */
export function resolveRawCardPriority(
  hidden: string | undefined | null,
  visible: string | undefined | null
): string | null {
  return (hidden || null) ?? (visible || null);
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Writes the priority value to the hidden slot, and to the visible one while
 * this KB is un-migrated.
 *
 * Both writes are awaited together: they are two slots of the same logical
 * value, and a reader that caught the gap would see the pre-write number in one
 * of them.
 */
export async function writeRawCardPriority(
  plugin: RNPlugin,
  rem: PluginRem,
  value: string
): Promise<void> {
  const writes: Promise<unknown>[] = [
    rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT, [value]),
  ];
  if (!(await isHiddenSlotMigrated(plugin))) {
    writes.push(rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, [value]));
  }
  await Promise.all(writes);
}

/**
 * Clears both slots. Used by every path that strips the tag — leaving a value
 * in the hidden slot behind a removed powerup would make it reappear the moment
 * the powerup came back.
 */
export async function clearRawCardPriority(rem: PluginRem): Promise<void> {
  await Promise.all([
    rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT, []).catch(() => undefined),
    rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, []).catch(() => undefined),
  ]);
}
