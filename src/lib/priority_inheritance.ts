import { Rem, RNPlugin } from '@remnote/plugin-sdk';
import { powerupCode, prioritySlotCode } from './consts';
import { getIncrementalRemInfo } from './incremental_rem';

export interface AncestorPriorityInfo {
  priority: number;
  ancestorRem: Rem;
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
  rem: Rem | undefined
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
          const ancestorText = await plugin.richText.toString(currentRem.text);
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
 * Gets the initial priority for a new incremental rem
 * Tries to inherit from closest incremental ancestor, otherwise uses default
 */
export async function getInitialPriority(
  plugin: RNPlugin,
  rem: Rem,
  defaultPriority: number
): Promise<number> {
  const ancestorInfo = await findClosestIncrementalAncestor(plugin, rem);
  
  if (ancestorInfo) {
    console.log(`Inheriting priority ${ancestorInfo.priority} from ancestor: ${ancestorInfo.ancestorName}`);
    return ancestorInfo.priority;
  }
  
  return defaultPriority;
}