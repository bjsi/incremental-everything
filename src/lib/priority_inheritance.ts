import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { powerupCode } from './consts';
import { getIncrementalRemFromRem } from './incremental_rem';
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

      // Check if this ancestor is an incremental rem
      const hasIncrementalPowerup = await currentRem.hasPowerup(powerupCode);

      if (hasIncrementalPowerup) {
        // Get the priority of this incremental ancestor
        const incRemInfo = await getIncrementalRemFromRem(plugin, currentRem);

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
 * * This version:
 * 1. Prefers showing the ancestor with manual Card Priority (if exists)
 * 2. Then checks for Incremental Rem priority
 * 3. Falls back to showing the highest inherited priority (orphaned cases) if no IncRem found
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

    // Fetch Card Priority details first
    const parentCardPriorityValue = await parent.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
    const parentCardSource = await parent.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT);

    // 1. Check for explicit CardPriority: MANUAL or INCREMENTAL source (Highest Precedence)
    // If source is "manual" or "incremental", we use this priority immediately,
    // overriding any IncRem priority on the same node.
    if (parentCardPriorityValue && (parentCardSource === 'manual' || parentCardSource === 'incremental')) {
      const priority = parseInt(parentCardPriorityValue);
      if (!isNaN(priority)) {
        const parentName = await safeRemTextToString(plugin, parent.text);
        const truncatedName = parentName.slice(0, 50) + (parentName.length > 50 ? '...' : '');

        return {
          priority: priority,
          ancestorName: truncatedName,
          sourceType: 'Card',
          level: currentLevel,
          levelDescription: getLevelDescription(currentLevel)
        };
      }
    }

    // 2. Check for Incremental Rem priority (Medium Precedence)
    // If source was not "manual", we check for IncRem. This overrides "inherited" or "default" Card Priorities.
    const parentIncInfo = await getIncrementalRemFromRem(plugin, parent);
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

    // 3. Check for INHERITED CardPriority (Lowest Precedence - Fallback)
    // If we haven't found a Manual Card Priority or an IncRem Priority, we track this as a potential candidate.
    if (parentCardPriorityValue) {
      const priority = parseInt(parentCardPriorityValue);
      if (!isNaN(priority)) {
        if (parentCardSource === 'inherited' && !highestInheritedAncestor) {
          // Track the highest inherited ancestor (closest to current rem)
          highestInheritedAncestor = { parent, priority, level: currentLevel };
        }
      }
    }

    current = parent;
  }

  // No manual priority or IncRem found, but we have an orphaned inherited priority
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