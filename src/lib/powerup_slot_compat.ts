// lib/powerup_slot_compat.ts
//
// Compatibility shim for `plugin.powerup.getPowerupSlotByCode`.
//
// Recent RemNote desktop builds (post storage/sync overhaul) deprecated the
// runtime implementation of `getPowerupSlotByCode`: every call now rejects with
//   "Plugin Error: Internal API Error: Error: getPowerupSlotByCode is deprecated"
// even though the method is still declared in @remnote/plugin-sdk@0.0.46 and in
// the public API docs. The sibling `getPowerupByCode` still works.
//
// This helper is a drop-in replacement that:
//   1. Tries the native method first (so it self-heals if RemNote restores it,
//      and stays correct on older builds where it works).
//   2. On failure (throw or undefined), resolves the slot definition rem by
//      walking the powerup rem's slot children and matching by name.
//
// Name-matching is authoritative for THIS plugin's own powerups (we register the
// slot names ourselves — see register/powerups.tsx). For built-in RemNote
// powerups it is best-effort (a built-in slot whose display name is localized or
// renamed simply won't resolve, which degrades gracefully to the same "slot not
// found" outcome the old code already tolerated for built-ins).

import { RNPlugin } from '@remnote/plugin-sdk';
import {
  powerupCode,
  prioritySlotCode,
  nextRepDateSlotCode,
  repHistorySlotCode,
  originalIncrementalDateSlotCode,
  dismissedPowerupCode,
  dismissedHistorySlotCode,
  dismissedDateSlotCode,
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  videoExtractStartSlotCode,
  videoExtractEndSlotCode,
} from './consts';
import { safeRemTextToString } from './pdfUtils';

// The rem type returned by the powerup namespace (RemObject | undefined),
// derived from the SDK so we don't depend on an internal type name.
type SlotRem = Awaited<ReturnType<RNPlugin['powerup']['getPowerupByCode']>>;

/**
 * Authoritative display names for this plugin's own powerup slots, mirroring the
 * `registerPowerup()` definitions in register/powerups.tsx. Keyed by
 * `${powerupCode}:${slotCode}`. Built-in powerups are intentionally absent — the
 * fallback also tries the slot code itself, which covers built-ins where the
 * code matches the display name.
 */
const PLUGIN_SLOT_DISPLAY_NAMES: Record<string, string> = {
  [`${powerupCode}:${prioritySlotCode}`]: 'Priority',
  [`${powerupCode}:${nextRepDateSlotCode}`]: 'Next Rep Date',
  [`${powerupCode}:${repHistorySlotCode}`]: 'History',
  [`${powerupCode}:${originalIncrementalDateSlotCode}`]: 'Created',
  'cardPriority:priority': 'Priority',
  'cardPriority:prioritySource': 'Priority Source',
  'cardPriority:lastUpdated': 'Last Updated',
  [`${dismissedPowerupCode}:${dismissedHistorySlotCode}`]: 'History',
  [`${dismissedPowerupCode}:${dismissedDateSlotCode}`]: 'Dismissed Date',
  [`${videoExtractPowerupCode}:${videoExtractUrlSlotCode}`]: 'Video URL',
  [`${videoExtractPowerupCode}:${videoExtractStartSlotCode}`]: 'Start Time',
  [`${videoExtractPowerupCode}:${videoExtractEndSlotCode}`]: 'End Time',
};

// Session memo of resolved slot rems, keyed by `${powerupCode}:${slotCode}`.
// Powerup slot definition rems are stable within a session, so caching avoids
// re-walking powerup children on every call (the fallback path runs on every
// call on affected builds). Only defined resolutions are cached.
const slotRemCache = new Map<string, NonNullable<SlotRem>>();

/** Clear the resolved-slot memo (e.g. if powerups are re-registered). */
export function clearPowerupSlotByCodeCache(): void {
  slotRemCache.clear();
}

// Normalize a name for tolerant comparison: lowercase, strip non-alphanumerics.
// So 'Read Percent' === 'ReadPercent' === 'readPercent'.
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function resolveViaChildren(
  plugin: RNPlugin,
  powerupCodeArg: string,
  slotCode: string
): Promise<SlotRem> {
  const powerup = await plugin.powerup.getPowerupByCode(powerupCodeArg);
  if (!powerup) return undefined;

  const expectedName = PLUGIN_SLOT_DISPLAY_NAMES[`${powerupCodeArg}:${slotCode}`];
  const candidates = new Set(
    [expectedName, slotCode].filter((s): s is string => !!s).map(normalize)
  );

  const children = await powerup.getChildrenRem();
  for (const child of children) {
    if (!(await child.isPowerupSlot())) continue;
    const name = await safeRemTextToString(plugin, child.text);
    if (name && candidates.has(normalize(name))) {
      return child;
    }
  }
  return undefined;
}

/**
 * Drop-in replacement for `plugin.powerup.getPowerupSlotByCode(powerupCode, slotCode)`.
 * Returns the slot definition rem, or undefined if it cannot be resolved.
 */
export async function getPowerupSlotByCodeSafe(
  plugin: RNPlugin,
  powerupCodeArg: string,
  slotCode: string
): Promise<SlotRem> {
  const cacheKey = `${powerupCodeArg}:${slotCode}`;
  const cached = slotRemCache.get(cacheKey);
  if (cached) return cached;

  // 1. Native method — works on older/future builds; throws "is deprecated" on
  //    affected builds.
  try {
    const slot = await plugin.powerup.getPowerupSlotByCode(powerupCodeArg, slotCode);
    if (slot) {
      slotRemCache.set(cacheKey, slot);
      return slot;
    }
  } catch {
    // Deprecated at runtime — fall through to the children-walk fallback.
  }

  // 2. Fallback: resolve by walking the powerup rem's slot children.
  const resolved = await resolveViaChildren(plugin, powerupCodeArg, slotCode);
  if (resolved) slotRemCache.set(cacheKey, resolved);
  return resolved;
}
