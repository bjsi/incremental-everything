// lib/powerup_slot_compat.ts
//
// Compatibility shim for `plugin.powerup.getPowerupSlotByCode`.
//
// Recent RemNote desktop builds (post storage/sync overhaul) narrowed the
// runtime implementation of `getPowerupSlotByCode`, even though the method is
// still declared in @remnote/plugin-sdk@0.0.46 and in the public API docs. The
// sibling `getPowerupByCode` still works.
//
// The failure is NOT blanket deprecation, as an earlier reading of this had it.
// A raw-slot dump (lib/raw_slot_dump.ts) captured the actual rejection:
//
//   "getPowerupSlotByCode only supports visible plugin powerup slots: built-in
//    and hidden slots are not represented as Rem. Use getPowerupProperty or
//    getPowerupPropertyAsRichText to read slot values instead."
//
// So it is selective, and the split is visible-vs-hidden:
//
//   VISIBLE slots (Priority, Next Rep Date)   -> still resolve natively.
//   HIDDEN  slots (History, Created, pdfState,
//                  Priority Source, Last Updated,
//                  the Dismissed slots)        -> throw the above.
//
// Note the error's premise is wrong in one respect, which is worth keeping in
// mind: hidden slots ARE still present as Rems — the fallback below finds them
// by walking the powerup's children and checking `isPowerupSlot()`, and it
// resolves every one of them. Only this accessor refuses to return them.
//
// The practical consequence is that hidden-slot VALUES no longer live in a child
// Rem of the tagged rem (a rem with History and Created set can have zero
// property children), while visible-slot values still do. Anything reasoning
// about property children must not assume the two behave alike.
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
  'cardPriority:priorityValue': 'Priority Value',
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

export type SlotResolutionPath = 'native' | 'fallback' | 'unresolved';

export interface SlotResolution {
  slot: SlotRem;
  path: SlotResolutionPath;
  /** Present when the native method threw (i.e. it is deprecated on this build). */
  nativeError?: string;
}

/**
 * Diagnostic variant of {@link getPowerupSlotByCodeSafe}: resolves the slot and
 * reports which path produced it — `native` (the SDK method still works),
 * `fallback` (native failed, the children-walk resolved it), or `unresolved`.
 * Bypasses the memo cache so it always exercises both paths. For probes only.
 */
export async function resolvePowerupSlotDiagnostic(
  plugin: RNPlugin,
  powerupCodeArg: string,
  slotCode: string
): Promise<SlotResolution> {
  try {
    const slot = await plugin.powerup.getPowerupSlotByCode(powerupCodeArg, slotCode);
    if (slot) return { slot, path: 'native' };
  } catch (e) {
    const resolved = await resolveViaChildren(plugin, powerupCodeArg, slotCode);
    return { slot: resolved, path: resolved ? 'fallback' : 'unresolved', nativeError: String(e) };
  }
  // Native returned undefined without throwing — try the fallback anyway.
  const resolved = await resolveViaChildren(plugin, powerupCodeArg, slotCode);
  return { slot: resolved, path: resolved ? 'fallback' : 'unresolved' };
}
