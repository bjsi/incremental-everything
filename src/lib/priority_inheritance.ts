import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { powerupCode } from './consts';
import { getIncrementalRemFromRem } from './incremental_rem';
import { getIncrementalRemFromCache } from './incremental_rem/cache';
import { safeRemTextToString } from './pdfUtils';

export interface AncestorPriorityInfo {
  priority: number;
  ancestorRem: PluginRem;
  ancestorName: string;
}

/**
 * Finds the closest ancestor rem that is an incremental rem and returns its priority
 * @param plugin The plugin instance
 * @param rem The rem to find ancestors for
 * @returns The ancestor priority info or null if no incremental ancestor found
 */
export async function findClosestIncrementalAncestor(
  plugin: RNPlugin,
  rem: PluginRem | undefined
): Promise<AncestorPriorityInfo | null> {
  if (!rem) return null;

  try {
    // Get the parent ID of the current rem
    let currentParentId = rem.parent;

    // Walk up the ancestor chain
    while (currentParentId) {
      // Get the parent rem
      const currentRem = await plugin.rem.findOne(currentParentId);
      if (!currentRem) break;

      // Check if this ancestor is an incremental rem using cache
      const incRemInfo = await getIncrementalRemFromCache(plugin, currentParentId);

      if (incRemInfo && incRemInfo.priority !== undefined) {
        // Get the name/text of the ancestor for display
        const ancestorText = await safeRemTextToString(plugin, currentRem.text);
        const ancestorName = ancestorText.slice(0, 50) + (ancestorText.length > 50 ? '...' : '');

        return {
          priority: incRemInfo.priority,
          ancestorRem: currentRem,
          ancestorName: ancestorName
        };
      }

      // Move up to the next ancestor
      currentParentId = currentRem.parent;
    }
  } catch (error) {
    console.error('Error finding incremental ancestor:', error);
  }
  
  return null;
}


/**
 * Helper function to generate user-friendly level description
 */
function getLevelDescription(level: number): string {
  switch (level) {
    case 1:
      return 'Parent';
    case 2:
      return 'Grandparent';
    case 3:
      return 'Great-grandparent';
    default:
      // For 4+ levels, use "5th ancestor", "6th ancestor", etc.
      return `${level}${getOrdinalSuffix(level)} ancestor`;
  }
}

/**
 * Helper function to get ordinal suffix (st, nd, rd, th)
 */
function getOrdinalSuffix(num: number): string {
  const j = num % 10;
  const k = num % 100;
  
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

/**
 * Find the closest ancestor with either an Incremental Rem priority or a Card priority
 *
 * IMPROVED - Handles both manual and orphaned inherited priorities
 * 
 * This version:
 * 1. Prefers showing the ancestor with manual priority (the true source)
 * 2. Falls back to showing the highest inherited priority (orphaned cases)
 */
export async function findClosestAncestorWithAnyPriority(
  plugin: RNPlugin,
  rem: PluginRem | undefined
): Promise<{ 
  priority: number; 
  ancestorName: string; 
  sourceType: 'IncRem' | 'Card';
  level: number;
  levelDescription: string;
} | null> {
  if (!rem) return null;

  const CARD_PRIORITY_CODE = 'cardPriority';
  const PRIORITY_SLOT = 'priority';
  const SOURCE_SLOT = 'prioritySource';

  let current = rem;
  let currentLevel = 0; // Track how many levels we've gone up
  let highestInheritedAncestor: { 
    parent: PluginRem; 
    priority: number;
    level: number;
  } | null = null;

  while (current.parent) {
    const parent = await plugin.rem.findOne(current.parent);
    if (!parent) break;
    
    currentLevel++; // Increment level for each parent we check

    // Check for Incremental Rem priority first using cache
    const parentIncInfo = await getIncrementalRemFromCache(plugin, parent._id);
    if (parentIncInfo) {
      const parentName = await safeRemTextToString(plugin, parent.text);
      const truncatedName = parentName.slice(0, 50) + (parentName.length > 50 ? '...' : '');

      return {
        priority: parentIncInfo.priority,
        ancestorName: truncatedName,
        sourceType: 'IncRem',
        level: currentLevel,
        levelDescription: getLevelDescription(currentLevel)
      };
    }
    
    // Check for CardPriority powerup
    const parentCardPriorityValue = await parent.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
    const parentCardSource = await parent.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);
    
    if (parentCardPriorityValue) {
      const priority = parseInt(parentCardPriorityValue);
      if (!isNaN(priority)) {
        
        if (parentCardSource === 'manual') {
          // Found the true source! Return immediately
          const parentName = await safeRemTextToString(plugin, parent.text);
          const truncatedName = parentName.slice(0, 50) + (parentName.length > 50 ? '...' : '');
          
          return { 
            priority: priority, 
            ancestorName: truncatedName, 
            sourceType: 'Card',
            level: currentLevel,
            levelDescription: getLevelDescription(currentLevel)
          };
        } else if (parentCardSource === 'inherited' && !highestInheritedAncestor) {
          // Track the highest inherited ancestor (closest to current rem)
          highestInheritedAncestor = { parent, priority, level: currentLevel };
        }
      }
    }
    
    current = parent;
  }
  
  // No manual priority found, but we have an orphaned inherited priority
  if (highestInheritedAncestor) {
    const parentName = await safeRemTextToString(plugin, highestInheritedAncestor.parent.text);
    const truncatedName = parentName.slice(0, 50) + (parentName.length > 50 ? '...' : '');
    
    return {
      priority: highestInheritedAncestor.priority,
      ancestorName: truncatedName,
      sourceType: 'Card',
      level: highestInheritedAncestor.level,
      levelDescription: getLevelDescription(highestInheritedAncestor.level)
    };
  }
  
  return null;
}


/**
 * EXAMPLES OF HOW THIS WORKS:
 * 
 * CASE 1: Normal inheritance (manual source exists)
 * Test Document (priority 44, manual)
 *   └── Inc Rem 1 (priority 44, inherited)  ← Tracked but not used
 *         └── Flashcard
 * Result: Returns "Test Document" ✅
 * 
 * CASE 2: Orphaned inheritance (manual source deleted/untagged)
 * Test Document (NO priority - untagged)
 *   └── Inc Rem 1 (priority 44, inherited)  ← Highest inherited, return this!
 *         └── Flashcard (priority 44, inherited)
 * Result: Returns "Inc Rem 1" ✅
 * 
 * CASE 3: Multiple inherited levels (orphaned)
 * Test Document (NO priority)
 *   └── Level 1 (priority 44, inherited)  ← Highest, return this!
 *         └── Level 2 (priority 44, inherited)
 *               └── Flashcard (priority 44, inherited)
 * Result: Returns "Level 1" ✅
 * 
 * CASE 4: No priorities anywhere
 * Test Document (NO priority)
 *   └── Inc Rem 1 (NO priority)
 *         └── Flashcard (priority 44, default)
 * Result: Returns null ✅
 */


/**
 * Gets the initial priority for a new incremental rem
 * Tries to inherit from closest ancestor with any priority (IncRem or Card), otherwise uses default
 */
export async function getInitialPriority(
  plugin: RNPlugin,
  rem: PluginRem,
  defaultPriority: number
): Promise<number> {
  const ancestorInfo = await findClosestAncestorWithAnyPriority(plugin, rem);
  
  if (ancestorInfo) {
    console.log(`Inheriting priority ${ancestorInfo.priority} from ${ancestorInfo.sourceType} ancestor: ${ancestorInfo.ancestorName}`);
    return ancestorInfo.priority;
  }
  
  return defaultPriority;
}