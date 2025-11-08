import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { powerupCode, prioritySlotCode } from './consts';
import { getIncrementalRemInfo } from './incremental_rem';
import { getCardPriority } from './cardPriority';
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
        const incRemInfo = await getIncrementalRemInfo(plugin, currentRem);
        
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
 * Find the closest ancestor with either an Incremental Rem priority or a Card priority
 */
export async function findClosestAncestorWithAnyPriority(
  plugin: RNPlugin,
  rem: PluginRem | undefined
): Promise<{ priority: number; ancestorName: string; sourceType: 'IncRem' | 'Card' } | null> {
  if (!rem) return null;

  let current = rem;
  while (current.parent) {
    const parent = await plugin.rem.findOne(current.parent);
    if (!parent) break;

    const parentName = await safeRemTextToString(plugin, parent.text);
    const truncatedName = parentName.slice(0, 50) + (parentName.length > 50 ? '...' : '');

    // Check for Incremental Rem priority first
    const parentIncInfo = await getIncrementalRemInfo(plugin, parent);
    if (parentIncInfo) {
      return { 
        priority: parentIncInfo.priority, 
        ancestorName: truncatedName, 
        sourceType: 'IncRem' 
      };
    }
    
    // Then check for CardPriority powerup
    const parentCardInfo = await getCardPriority(plugin, parent);
    // We only care about manually set or already-inherited priorities on ancestors
    if (parentCardInfo && parentCardInfo.source !== 'default') {
      return { 
        priority: parentCardInfo.priority, 
        ancestorName: truncatedName, 
        sourceType: 'Card' 
      };
    }
    
    current = parent;
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