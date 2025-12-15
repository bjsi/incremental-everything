// lib/powerupSlotFilter.ts
// Utility functions to filter out powerup slot rems from children and descendants
// These slots (Priority, Next Rep Date, Sources, PDF Metadata, View Modes, etc.) add clutter.

import { RNPlugin, PluginRem, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode, prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode } from './consts';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT } from './card_priority/types';

/**
 * Configuration for plugin powerups and their slots to filter
 */
const PLUGIN_POWERUP_SLOT_CONFIGS = [
  {
    powerupCode: powerupCode, // 'incremental'
    slotCodes: [prioritySlotCode, nextRepDateSlotCode, repHistorySlotCode]
  },
  {
    powerupCode: CARD_PRIORITY_CODE, // 'cardPriority'  
    slotCodes: [PRIORITY_SLOT, SOURCE_SLOT, LAST_UPDATED_SLOT]
  }
];

/**
 * Built-in RemNote powerup codes and their slot codes to filter
 * These are standard RemNote features like Sources, PDF metadata, Highlights, Search Portals, etc.
 */
const BUILTIN_POWERUP_SLOT_CONFIGS: Array<{
  powerupCode: BuiltInPowerupCodes;
  slotCodes: string[];
}> = [
  {
    powerupCode: BuiltInPowerupCodes.Sources,
    slotCodes: ['Sources'] // The "Sources" slot that appears when you add a source to a rem
  },
  {
    powerupCode: BuiltInPowerupCodes.UploadedFile, // PDF/File metadata
    slotCodes: [
      'Type', 
      'URL', 
      'Name', 
      'Authors', 
      'Keywords', 
      'Title', 
      'ViewerData', 
      'ReadPercent', 
      'LastReadDate', 
      'HasNoTextLayer', 
      'Theme',
      // Text Reader / HTML View specific slots
      'ShouldOpenInTextReader',
      'ViewInHTMLMode'
    ]
  },
  {
    powerupCode: BuiltInPowerupCodes.PDFHighlight, // PDF Highlights
    slotCodes: ['Data', 'PdfId']
  },
  {
    powerupCode: BuiltInPowerupCodes.HTMLHighlight, // HTML Highlights
    slotCodes: ['Data', 'HTMLId']
  },
  {
    powerupCode: BuiltInPowerupCodes.WebHighlight, // Web Highlights
    slotCodes: ['Data', 'Url']
  },
  {
    powerupCode: BuiltInPowerupCodes.Link, // URL/Link metadata
    slotCodes: ['URL', 'Title', 'ReadPercent', 'LastReadDate', 'FileURL']
  },
  {
    powerupCode: BuiltInPowerupCodes.Aliases, // Aliases
    slotCodes: ['Aliases']
  },
  {
    powerupCode: BuiltInPowerupCodes.Todo, // Checkbox status
    slotCodes: ['Status']
  },
  {
    powerupCode: BuiltInPowerupCodes.SearchPortal, // Search Portals
    slotCodes: ['Query', 'Filter', 'AutomaticBacklinkSearchPortalFor', 'DontIncludeNestedDescendants']
  },
  {
    powerupCode: BuiltInPowerupCodes.Header, // Header sizes
    slotCodes: ['Size']
  },
  {
    powerupCode: BuiltInPowerupCodes.AutoSort, // Auto sort configuration
    slotCodes: ['SortDirection']
  },
  {
    powerupCode: BuiltInPowerupCodes.UsedAsTag, // Tag configuration
    slotCodes: ['AutoActivate', 'Pinned', 'CollapseConfigure', 'PrimaryColumnName']
  },
  {
    powerupCode: BuiltInPowerupCodes.Document, // Document status
    slotCodes: ['Status', 'DeprecatedSource']
  }
];

/**
 * Cache for powerup slot RemIds to avoid repeated lookups
 * Key: powerupCode:slotCode, Value: RemId of the slot definition
 */
let powerupSlotIdsCache: Map<string, RemId> | null = null;

/**
 * Initializes the cache of powerup slot RemIds
 * These are the slot DEFINITION rems (the tag rems that property children reference)
 */
export async function initPowerupSlotIdsCache(plugin: RNPlugin): Promise<void> {
  powerupSlotIdsCache = new Map();

  // Cache plugin powerup slots
  for (const config of PLUGIN_POWERUP_SLOT_CONFIGS) {
    for (const slotCode of config.slotCodes) {
      try {
        const slotRem = await plugin.powerup.getPowerupSlotByCode(config.powerupCode, slotCode);
        if (slotRem) {
          const cacheKey = `${config.powerupCode}:${slotCode}`;
          powerupSlotIdsCache.set(cacheKey, slotRem._id);
          console.log(`[PowerupSlotFilter] Cached slot "${slotCode}" for powerup "${config.powerupCode}": ${slotRem._id}`);
        }
      } catch (error) {
        console.warn(`[PowerupSlotFilter] Failed to get slot "${slotCode}" for powerup "${config.powerupCode}":`, error);
      }
    }
  }

  // Cache built-in RemNote powerup slots
  for (const config of BUILTIN_POWERUP_SLOT_CONFIGS) {
    for (const slotCode of config.slotCodes) {
      try {
        const slotRem = await plugin.powerup.getPowerupSlotByCode(config.powerupCode, slotCode);
        if (slotRem) {
          const cacheKey = `builtin:${config.powerupCode}:${slotCode}`;
          powerupSlotIdsCache.set(cacheKey, slotRem._id);
        }
      } catch (error) {
        // Suppress warnings for built-ins
      }
    }
  }
  
  console.log(`[PowerupSlotFilter] Cached ${powerupSlotIdsCache.size} slot IDs total`);
}

/**
 * Gets all powerup slot definition RemIds
 * Initializes cache if needed
 */
export async function getAllPowerupSlotIds(plugin: RNPlugin): Promise<Set<RemId>> {
  if (!powerupSlotIdsCache) {
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
 * Alternative check using rem text matching
 * This is a fallback if the tag-based check doesn't work
 */
export async function isPowerupPropertyChildByName(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  // Known slot names from both plugin powerups and built-in powerups
  const knownSlotNames = new Set([
    // Incremental powerup slots
    'Priority', 'Next Rep Date', 'History',
    // CardPriority powerup slots
    'Priority Source', 'Last Updated',
    // Built-in RemNote slots (Sources, Aliases, etc)
    'Sources', 'Source', 'Aliases', 'Status',
    // PDF / File Metadata
    'Type', 'URL', 'Name', 'Authors', 'Keywords', 'Title', 'ViewerData', 
    'ReadPercent', 'LastReadDate', 'HasNoTextLayer', 'Theme',
    // Text Reader / View Mode Metadata
    'ShouldOpenInTextReader', 'ViewInHTMLMode',
    // Highlights
    'Data', 'PdfId', 'HTMLId', 'Url', 'FileURL',
    // Search Portal
    'Query', 'Filter', 'AutomaticBacklinkSearchPortalFor', 'DontIncludeNestedDescendants',
    // Header
    'Size',
    // AutoSort
    'SortDirection',
    // Tag Config
    'AutoActivate', 'Pinned', 'CollapseConfigure', 'PrimaryColumnName',
    // PDF Structural/State Rems
    'Pages', 
    'Highlights', 
    'Last Zoom Workspace Point',
    // Generic Query catch (lowercase/uppercase)
    'query',
    // Explicit Untitled
    'Untitled'
  ]);
  
  try {
    const remText = await plugin.richText.toString(rem.text);
    const text = remText ? remText.trim() : '';
    
    // Check 1: Empty text, "Untitled", Exact Match, or "Starts With Query"
    const isNameMatch = text === '' ||
                        text === 'Untitled' ||
                        knownSlotNames.has(text) || 
                        text.toLowerCase().startsWith('query') || 
                        text === 'Automatic Backlink Search Portal';

    if (isNameMatch) {
      // Additional check: verify parent has a relevant powerup or has sources
      // This prevents filtering valid empty/untitled rems that are just user notes
      if (rem.parent) {
        const parent = await plugin.rem.findOne(rem.parent);
        if (parent) {
          // 1. Check for plugin powerups
          const hasIncremental = await parent.hasPowerup(powerupCode);
          const hasCardPriority = await parent.hasPowerup(CARD_PRIORITY_CODE);
          if (hasIncremental || hasCardPriority) return true;

          // 2. Check for Built-in Powerups that generate these slots
          const builtInPowerupsToCheck = [
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
            BuiltInPowerupCodes.Document
          ];

          for (const code of builtInPowerupsToCheck) {
            if (await parent.hasPowerup(code)) return true;
          }
          
          // 3. Special Case: Filter Search Portals (Backlinks) under PDFs
          // If the child rem ITSELF is a Search Portal and parent is a PDF, it's metadata.
          if (await rem.hasPowerup(BuiltInPowerupCodes.SearchPortal) && 
              (await parent.hasPowerup(BuiltInPowerupCodes.UploadedFile))) {
            return true;
          }
          
          // 4. Check for sources (special case)
          try {
            const sources = await parent.getSources();
            if (sources.length > 0 && (text === 'Sources' || text === 'Source')) {
              return true;
            }
          } catch {
            // Ignore errors when checking sources
          }
        }
      }
    }
  } catch (error) {
    // Ignore errors in fallback check
  }
  
  return false;
}

/**
 * Combined check for powerup property children
 * Uses tag-based check first, falls back to name-based check
 */
export async function isPowerupSlotChild(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  // First try the tag-based check (most reliable)
  const isTagged = await isPowerupPropertyChild(plugin, rem);
  if (isTagged) return true;
  
  // Fall back to name-based check
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
}