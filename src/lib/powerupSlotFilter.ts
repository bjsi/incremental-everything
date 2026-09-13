// lib/powerupSlotFilter.ts
// Utility functions to filter out powerup slot rems from children and descendants
// These slots (Priority, Next Rep Date, Sources, PDF Metadata, View Modes, etc.) add clutter.

import { RNPlugin, PluginRem, RemId, BuiltInPowerupCodes, PowerupSlotCodeMap } from '@remnote/plugin-sdk';
import { powerupCode, prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode, originalIncrementalDateSlotCode, dismissedPowerupCode, dismissedHistorySlotCode, dismissedDateSlotCode, videoExtractPowerupCode, videoExtractUrlSlotCode, videoExtractStartSlotCode, videoExtractEndSlotCode } from './consts';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT } from './card_priority/types';
import { safeRemTextToString } from './pdfUtils';
import { getPowerupSlotByCodeSafe } from './powerup_slot_compat';

/**
 * Configuration for plugin powerups and their slots to filter
 */
const PLUGIN_POWERUP_SLOT_CONFIGS = [
  {
    powerupCode: powerupCode, // 'incremental'
    slotCodes: [prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode, originalIncrementalDateSlotCode]
  },
  {
    powerupCode: CARD_PRIORITY_CODE, // 'cardPriority'
    slotCodes: [PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT]
  },
  {
    powerupCode: dismissedPowerupCode, // 'dismissed'
    slotCodes: [dismissedHistorySlotCode, dismissedDateSlotCode]
  },
  {
    powerupCode: videoExtractPowerupCode, // 'videoExtract'
    slotCodes: [videoExtractUrlSlotCode, videoExtractStartSlotCode, videoExtractEndSlotCode]
  }
];

/**
 * Built-in RemNote powerups that declare slots, as `powerupCode -> slot names`.
 *
 * Enumerated from the SDK's own `PowerupSlotCodeMap` rather than hand-copied, so
 * the coverage tracks whatever @remnote/plugin-sdk the plugin is built against
 * instead of drifting from it. That is also strictly broader than the list this
 * replaced: Deck, Code, Callout, Collection, EmbedWebsite, Website, Image,
 * DailyDocument, EditLater, Highlight, AppliedTemplates and RestoredFromTrash
 * all declare slots too, and were previously unfiltered.
 *
 * The keys of each entry are slot NAMES (the display text a legacy slot rem
 * carries); the values in the map are the internal slot codes, which nothing
 * here needs — built-in slots are resolved by walking the powerup rem's
 * children (see initPowerupSlotIdsCache), because `getPowerupSlotByCode`
 * rejects built-ins outright on current builds.
 */
const BUILTIN_SLOT_NAMES: Array<[BuiltInPowerupCodes, string[]]> = Object.entries(
  PowerupSlotCodeMap as unknown as Record<string, Record<string, string>>
)
  .map(([code, slots]) => [code as BuiltInPowerupCodes, Object.keys(slots)] as [BuiltInPowerupCodes, string[]])
  .filter(([, names]) => names.length > 0);

/**
 * Slot names that no entry in `PowerupSlotCodeMap` declares, mapped to the powerup
 * that actually owns them. Two sources:
 *   - Slots RemNote shipped after the SDK types were last regenerated
 *     (the Text Reader / HTML View pair on UploadedFile).
 *   - Structural children RemNote materialises under a PDF that are not slots in
 *     the type map but behave exactly like metadata in a child list.
 */
const EXTRA_BUILTIN_SLOT_OWNERS: Array<[string, BuiltInPowerupCodes]> = [
  ['ShouldOpenInTextReader', BuiltInPowerupCodes.UploadedFile],
  ['ViewInHTMLMode', BuiltInPowerupCodes.UploadedFile],
  ['Pages', BuiltInPowerupCodes.UploadedFile],
  ['Highlights', BuiltInPowerupCodes.UploadedFile],
  ['Last Zoom Workspace Point', BuiltInPowerupCodes.UploadedFile],
  ['Source', BuiltInPowerupCodes.Sources],
];

/**
 * Display names of this plugin's own slots, mapped to the powerup that declares
 * each one. Mirrors register/powerups.tsx; only a backstop, since the real names
 * are read off the slot definition rems whenever those resolve (which is also how
 * a LOCALIZED slot name gets matched — a hand-written English list cannot).
 */
const PLUGIN_SLOT_NAME_OWNERS: Array<[string, string]> = [
  ['Priority', powerupCode],
  ['Next Rep Date', powerupCode],
  ['History', powerupCode],
  ['Created', powerupCode],
  ['Priority', CARD_PRIORITY_CODE],
  ['Priority Value', CARD_PRIORITY_CODE],
  ['Priority Source', CARD_PRIORITY_CODE],
  ['Last Updated', CARD_PRIORITY_CODE],
  ['History', dismissedPowerupCode],
  ['Dismissed Date', dismissedPowerupCode],
  ['Video URL', videoExtractPowerupCode],
  ['Start Time', videoExtractPowerupCode],
  ['End Time', videoExtractPowerupCode],
];

/**
 * Names that identify a metadata child but belong to no single powerup: an empty
 * or "Untitled" stray, a search-portal body, a backlink portal. These keep the
 * original broad guard (any metadata-bearing powerup on the parent will do),
 * because there is no specific owner to check against.
 */
const UNOWNED_METADATA_NAMES = new Set(['', 'untitled', 'automaticbacklinksearchportal']);

/** Powerups whose presence on the PARENT justifies dropping an unowned metadata name. */
const METADATA_BEARING_POWERUPS: Array<BuiltInPowerupCodes | string> = [
  powerupCode,
  CARD_PRIORITY_CODE,
  dismissedPowerupCode,
  videoExtractPowerupCode,
  BuiltInPowerupCodes.UploadedFile,
  BuiltInPowerupCodes.PDFHighlight,
  BuiltInPowerupCodes.HTMLHighlight,
  BuiltInPowerupCodes.WebHighlight,
  BuiltInPowerupCodes.Link,
  BuiltInPowerupCodes.Aliases,
  BuiltInPowerupCodes.Todo,
  BuiltInPowerupCodes.SearchPortal,
  BuiltInPowerupCodes.Header,
  BuiltInPowerupCodes.AutoSort,
  BuiltInPowerupCodes.UsedAsTag,
  BuiltInPowerupCodes.Document,
];

/** Tolerant name comparison: 'Read Percent' === 'ReadPercent' === 'readPercent'. */
const normalizeSlotName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Cache for powerup slot RemIds to avoid repeated lookups
 * Key: powerupCode:slotCode, Value: RemId of the slot definition
 */
let powerupSlotIdsCache: Map<string, RemId> | null = null;

/**
 * Which powerup(s) declare a given slot NAME, keyed by normalized name.
 *
 * This is what makes the name-based fallback specific instead of global. The old
 * behaviour matched a name against one flat set and then accepted ANY metadata
 * powerup on the parent, so a user's own child rem called "Title", "Name", "URL",
 * "Status" or "Data" was silently dropped from the Parent Selector as soon as its
 * parent happened to be an incremental rem — which, in this plugin, is most rems.
 * Requiring the parent to carry the powerup that actually DECLARES that slot name
 * keeps every real slot filtered while giving those user rems back.
 *
 * Seeded from the static tables above and then extended, during cache init, with
 * the real display names read off the slot definition rems that resolved.
 */
let slotNameOwnersCache: Map<string, Set<string>> | null = null;

/** Record `name` as owned by `code` in the name -> owners index being built. */
function recordSlotNameOwner(index: Map<string, Set<string>>, name: string, code: string): void {
  const key = normalizeSlotName(name);
  if (!key) return;
  const owners = index.get(key);
  if (owners) owners.add(code);
  else index.set(key, new Set([code]));
}

/**
 * Initializes the cache of powerup slot RemIds
 * These are the slot DEFINITION rems (the tag rems that property children reference)
 */
let slotCacheInFlight: Promise<void> | null = null;

/**
 * Builds the slot caches once, however many callers ask at the same time.
 * Concurrent callers share the in-flight build and only see the caches once they
 * are complete — they used to be published empty at the start, so a second
 * caller got a partial set and could let a slot row through.
 */
export function initPowerupSlotIdsCache(plugin: RNPlugin): Promise<void> {
  if (!slotCacheInFlight) {
    slotCacheInFlight = buildPowerupSlotIdsCache(plugin).finally(() => {
      slotCacheInFlight = null;
    });
  }
  return slotCacheInFlight;
}

async function buildPowerupSlotIdsCache(plugin: RNPlugin): Promise<void> {
  const idCache = new Map<string, RemId>();

  // Seed the name -> owners index from the static tables. Anything resolved below
  // adds to it (including localized names), it never replaces these.
  const nameOwners = new Map<string, Set<string>>();
  for (const [name, code] of PLUGIN_SLOT_NAME_OWNERS) recordSlotNameOwner(nameOwners, name, code);
  for (const [code, names] of BUILTIN_SLOT_NAMES) {
    for (const name of names) recordSlotNameOwner(nameOwners, name, code);
  }
  for (const [name, code] of EXTRA_BUILTIN_SLOT_OWNERS) recordSlotNameOwner(nameOwners, name, code);

  // Cache plugin powerup slots
  for (const config of PLUGIN_POWERUP_SLOT_CONFIGS) {
    for (const slotCode of config.slotCodes) {
      try {
        const slotRem = await getPowerupSlotByCodeSafe(plugin, config.powerupCode, slotCode);
        if (slotRem) {
          const cacheKey = `${config.powerupCode}:${slotCode}`;
          idCache.set(cacheKey, slotRem._id);
          // The rem's own text is the authoritative display name — a renamed or
          // localized slot only matches by name because of this.
          try {
            const slotName = await safeRemTextToString(plugin, slotRem.text);
            if (slotName) recordSlotNameOwner(nameOwners, slotName, config.powerupCode);
          } catch {
            // Name capture is a bonus; the id is what matters.
          }
          console.log(`[PowerupSlotFilter] Cached slot "${slotCode}" for powerup "${config.powerupCode}": ${slotRem._id}`);
        }
      } catch (error) {
        console.warn(`[PowerupSlotFilter] Failed to get slot "${slotCode}" for powerup "${config.powerupCode}":`, error);
      }
    }
  }

  // Cache built-in RemNote powerup slots.
  //
  // Not via getPowerupSlotByCodeSafe: for a built-in, the native call always
  // rejects ("built-in and hidden slots have no supported Rem representation"),
  // so every one of the ~90 slot codes would fall through to that helper's
  // children-walk fallback — one full walk per slot code, none of them cacheable
  // when unresolved. Walking each powerup ONCE and keeping every slot child it
  // has costs ~25 walks instead, and it also picks up slots the SDK's type map
  // does not list. Legacy slot rems (written before the storage overhaul) are
  // exactly what this finds; a knowledge base with none simply caches nothing.
  await Promise.all(
    BUILTIN_SLOT_NAMES.map(async ([code]) => {
      try {
        const powerup = await plugin.powerup.getPowerupByCode(code);
        if (!powerup) return;
        const children = await powerup.getChildrenRem();
        for (const child of children) {
          try {
            if (!(await child.isPowerupSlot())) continue;
          } catch {
            continue;
          }
          const slotName = await safeRemTextToString(plugin, child.text).catch(() => '');
          idCache.set(`builtin:${code}:${slotName || child._id}`, child._id);
          if (slotName) recordSlotNameOwner(nameOwners, slotName, code);
        }
      } catch {
        // Suppress warnings for built-ins
      }
    })
  );

  powerupSlotIdsCache = idCache;
  slotNameOwnersCache = nameOwners;

  console.log(`[PowerupSlotFilter] Cached ${idCache.size} slot IDs total`);
}

/**
 * Gets the normalized slot name -> owning powerup codes index.
 * Initializes the cache if needed.
 */
async function getSlotNameOwners(plugin: RNPlugin): Promise<Map<string, Set<string>>> {
  if (!slotNameOwnersCache || slotCacheInFlight) {
    await initPowerupSlotIdsCache(plugin);
  }
  return slotNameOwnersCache!;
}

/**
 * Gets all powerup slot definition RemIds
 * Initializes cache if needed
 */
export async function getAllPowerupSlotIds(plugin: RNPlugin): Promise<Set<RemId>> {
  if (!powerupSlotIdsCache || slotCacheInFlight) {
    await initPowerupSlotIdsCache(plugin);
  }

  return new Set(powerupSlotIdsCache!.values());
}

/**
 * Checks if a rem is a powerup property child
 * * When a rem is tagged with a powerup (like Incremental or has Sources), RemNote creates child rems
 * for each property slot. These children are TAGGED with the slot definition rem.
 * * This function checks if a rem is one of these property children by checking
 * if any of its tags match our cached slot definition IDs.
 */
export async function isPowerupPropertyChild(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  const slotIds = await getAllPowerupSlotIds(plugin);
  if (slotIds.size === 0) return false;

  try {
    // Get all tags on this rem
    const tags = await rem.getTagRems();
    
    // Check if any tag is a powerup slot definition
    for (const tag of tags) {
      if (slotIds.has(tag._id)) {
        return true;
      }
    }
  } catch (error) {
    // If getTagRems fails, try an alternative approach
    console.warn('[PowerupSlotFilter] getTagRems failed, trying alternative check:', error);
  }
  
  return false;
}

/**
 * Compatibility wrapper for `rem.isPowerupProperty()`.
 *
 * Recent RemNote desktop builds deprecated `isPowerupProperty` at runtime (it now
 * throws "Internal API Error: isPowerupProperty is deprecated"), just like
 * `getPowerupSlotByCode`. This tries the native method first (so it self-heals if
 * RemNote restores it) and, on failure, falls back to the tag-based detection
 * ({@link isPowerupPropertyChild}), which identifies a powerup slot instance by
 * whether it is tagged with one of our cached slot-definition ids — no deprecated
 * primitive involved. The fallback is conservative (returns false for anything it
 * cannot positively identify), which is the safe direction for the callers that
 * use it to decide whether a rem is a deletable slot node.
 */
export async function isPowerupPropertySafe(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  try {
    return await rem.isPowerupProperty();
  } catch {
    return await isPowerupPropertyChild(plugin, rem);
  }
}

/**
 * Name-based fallback for a powerup property child, used when the tag-based check
 * cannot see the slot definition (built-in slots that no longer exist as rems, a
 * knowledge base whose slot rems predate the storage overhaul, getTagRems failing).
 *
 * The name alone is never enough — "Priority", "Title" and "Status" are all things
 * a user writes. So a match requires the PARENT to carry a powerup that actually
 * DECLARES that slot name (see slotNameOwnersCache). Names that belong to no single
 * powerup — an empty or "Untitled" stray, a search portal body, a backlink portal —
 * fall back to the older, broader guard, since there is no specific owner to check.
 */
export async function isPowerupPropertyChildByName(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  try {
    const rawText = (await safeRemTextToString(plugin, rem.text)).trim();

    // A powerup slot instance's text is a single REFERENCE to its slot
    // DEFINITION. safeRemTextToString became reference-aware and now resolves +
    // wraps such references in `[ ]` (e.g. "[Priority]" / "[Size]" / "[Sources]"),
    // which broke the bare-name matching below and let known slots leak into the
    // Parent Selector. Strip one surrounding bracket pair so the bare name matches
    // again — but ONLY when the text is genuinely a reference, so a user note
    // literally typed as "[Priority]" is never affected. (Brackets are not the
    // slot-detection signal anyway: the primary tag-based check handles that, and
    // this name fallback still requires the parent-powerup guard below.)
    const textIsReference =
      Array.isArray(rem.text) &&
      rem.text.some((el: any) => el != null && typeof el === 'object' && el.i === 'q');
    const text =
      textIsReference && rawText.startsWith('[') && rawText.endsWith(']')
        ? rawText.slice(1, -1).trim()
        : rawText;

    if (!rem.parent) return false;
    const normalized = normalizeSlotName(text);

    // A search portal body is metadata wherever it sits under one of the powerups
    // below; it carries the query text, so it can never match by name. The colon is
    // required (the body reads "query:<the query>"): matching a bare "query" prefix
    // also swallowed user rems like "Query optimization notes".
    const isPortalBody = text.toLowerCase().startsWith('query:');
    const isUnownedMetadata = UNOWNED_METADATA_NAMES.has(normalized) || isPortalBody;

    const owners = isUnownedMetadata ? undefined : (await getSlotNameOwners(plugin)).get(normalized);
    if (!owners && !isUnownedMetadata) return false;

    const parent = await plugin.rem.findOne(rem.parent);
    if (!parent) return false;

    // Owned name: only the powerup that declares this slot justifies dropping it.
    if (owners) {
      for (const code of owners) {
        if (await parent.hasPowerup(code as BuiltInPowerupCodes)) return true;
      }
    } else {
      // Unowned metadata: the original broad guard.
      for (const code of METADATA_BEARING_POWERUPS) {
        if (await parent.hasPowerup(code as BuiltInPowerupCodes)) return true;
      }
    }

    // Special case: a Search Portal under a PDF is the backlinks portal RemNote
    // adds itself, whatever its text says.
    if (
      (await rem.hasPowerup(BuiltInPowerupCodes.SearchPortal)) &&
      (await parent.hasPowerup(BuiltInPowerupCodes.UploadedFile))
    ) {
      return true;
    }

    // Special case: the "Sources" child. The parent does not reliably carry the
    // Sources powerup, so the presence of actual sources is the guard.
    if (normalized === 'sources' || normalized === 'source') {
      try {
        const sources = await parent.getSources();
        if (sources.length > 0) return true;
      } catch {
        // Ignore errors when checking sources
      }
    }
  } catch (error) {
    // Ignore errors in fallback check
  }

  return false;
}

/**
 * Checks whether a rem's TEXT is a reference to a slot definition.
 *
 * This is the primary structural link: a powerup property rem's text is a single
 * reference to its slot DEFINITION, with the value in its backText (documented in
 * lib/raw_slot_dump.ts, which reads the same structure). Tags are the secondary
 * link — CardPriority's slot instances use them, incremental's do not necessarily.
 * Checking tags alone therefore misses the most common shape and pushes the work
 * onto the name fallback, which is precisely the check that has to guess.
 *
 * Deliberately NOT wired into {@link isPowerupPropertyChild}: that one backs
 * {@link isPowerupPropertySafe}, which gates DELETION in card_priority/batch.ts.
 * A user rem that merely references a slot definition would become deletable. The
 * conservative tag-only answer is the right one there; this signal is for the
 * display-side filtering below, where a false negative just means clutter.
 */
async function hasSlotDefinitionReference(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  const rich = rem?.text;
  if (!Array.isArray(rich) || rich.length === 0) return false;

  const slotIds = await getAllPowerupSlotIds(plugin);
  if (slotIds.size === 0) return false;

  return rich.some(
    (el: any) => el != null && typeof el === 'object' && el.i === 'q' && el._id && slotIds.has(String(el._id))
  );
}

/**
 * Combined check for powerup property children.
 * Reference-based check first, then tag-based, then the name fallback.
 */
export async function isPowerupSlotChild(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  // The primary structural link: text references the slot definition.
  if (await hasSlotDefinitionReference(plugin, rem)) return true;

  // Secondary link: tagged with the slot definition.
  const isTagged = await isPowerupPropertyChild(plugin, rem);
  if (isTagged) return true;

  // Last resort: name + owning-powerup guard.
  return isPowerupPropertyChildByName(plugin, rem);
}

/**
 * Filters out powerup slot/property rems from an array of rems
 */
export async function filterOutPowerupSlots(
  plugin: RNPlugin,
  rems: PluginRem[]
): Promise<PluginRem[]> {
  if (rems.length === 0) return [];
  
  // Ensure cache is initialized
  await getAllPowerupSlotIds(plugin);
  
  const filtered: PluginRem[] = [];
  
  for (const rem of rems) {
    const isSlotChild = await isPowerupSlotChild(plugin, rem);
    if (!isSlotChild) {
      filtered.push(rem);
    }
  }
  
  return filtered;
}

/**
 * Batch filter for better performance with large arrays
 * Processes rems in parallel batches
 */
export async function filterOutPowerupSlotsBatched(
  plugin: RNPlugin,
  rems: PluginRem[],
  batchSize: number = 20
): Promise<PluginRem[]> {
  if (rems.length === 0) return [];
  
  // Ensure cache is initialized
  await getAllPowerupSlotIds(plugin);
  
  const results: boolean[] = [];
  
  // Process in batches for better performance
  for (let i = 0; i < rems.length; i += batchSize) {
    const batch = rems.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(rem => isPowerupSlotChild(plugin, rem))
    );
    results.push(...batchResults);
  }
  
  // Filter based on results
  return rems.filter((_, index) => !results[index]);
}

/**
 * Gets children excluding powerup slots
 */
export async function getChildrenExcludingSlots(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<PluginRem[]> {
  const children = await rem.getChildrenRem();
  return filterOutPowerupSlots(plugin, children);
}

/**
 * Gets descendants excluding powerup slots
 * Uses batched processing for better performance
 */
export async function getDescendantsExcludingSlots(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<PluginRem[]> {
  const descendants = await rem.getDescendants();
  return filterOutPowerupSlotsBatched(plugin, descendants, 50);
}

/**
 * Counts children excluding powerup slots
 */
export async function countChildrenExcludingSlots(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<number> {
  const filtered = await getChildrenExcludingSlots(plugin, rem);
  return filtered.length;
}

/**
 * Counts descendants excluding powerup slots
 */
export async function countDescendantsExcludingSlots(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<number> {
  const filtered = await getDescendantsExcludingSlots(plugin, rem);
  return filtered.length;
}

/**
 * Clears the powerup slot IDs cache
 * Call this if powerups are modified and you need to refresh
 */
export function clearPowerupSlotIdsCache(): void {
  powerupSlotIdsCache = null;
  slotNameOwnersCache = null;
}