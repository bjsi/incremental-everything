import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { defaultPriorityId, priorityStepSizeId } from './consts';
import { getInitialPriority } from './priority_inheritance';
import { getIncrementalRemFromRem } from './incremental_rem';

// Cap on how many step-size decrements (= priority-number increments)
// can be auto-applied to a new cloze. Even on the 7th cloze, we apply 5 steps.
export const CLOZE_DECREMENT_CAP = 5;

export interface ClozeAutoPriorityInfo {
  /** Final card priority to assign to the new cloze rem (clamped to [0, 100]). */
  priority: number;
  /** The parent extract's resolved priority. */
  parentPriority: number;
  /** Where the parent's priority came from (for the widget label). */
  parentPrioritySource: 'incremental' | 'card-or-inherited';
  /** Number of existing #cloze-extract children of the parent (excluding the new cloze). */
  clozeChildCount: number;
  /** min(clozeChildCount, CLOZE_DECREMENT_CAP). */
  decrementsApplied: number;
  /** Step size used (from settings). */
  stepSize: number;
}

/**
 * Compute the auto card-priority for a new cloze deletion child of `parentRem`.
 *
 * Parent priority resolution:
 *   1. If parent has the IncRem powerup → use its IncRem priority.
 *   2. Else `getInitialPriority` — own cardPriority slot (manual/incremental) → ancestor
 *      traversal (IncRem-preferred) → defaultPriority setting. Same logic `opt+x` would use.
 *
 * Cloze child count: live count of parent's children that carry the `cloze-extract` tag.
 * The caller must invoke this BEFORE creating/parenting the new cloze rem, so the count
 * reflects only PRIOR clozes (not the one about to be created).
 *
 * Final priority = clamp(parentPriority + min(count, 5) × stepSize, 0, 100).
 * Higher number = less important, so each subsequent cloze becomes less important than the previous.
 */
export async function computeClozeAutoPriority(
  plugin: RNPlugin,
  parentRem: PluginRem
): Promise<ClozeAutoPriorityInfo> {
  const defaultPriority = (await plugin.settings.getSetting<number>(defaultPriorityId)) || 50;
  const stepSize = (await plugin.settings.getSetting<number>(priorityStepSizeId)) || 10;

  let parentPriority: number;
  let parentPrioritySource: 'incremental' | 'card-or-inherited';

  const incInfo = await getIncrementalRemFromRem(plugin, parentRem);
  if (incInfo) {
    parentPriority = incInfo.priority;
    parentPrioritySource = 'incremental';
  } else {
    parentPriority = await getInitialPriority(plugin, parentRem, defaultPriority);
    parentPrioritySource = 'card-or-inherited';
  }

  // Count existing cloze-extract children (live count — robust to manual deletions)
  const clozeExtractTag = await plugin.rem.findByName(['cloze-extract'], null);
  let clozeChildCount = 0;
  if (clozeExtractTag) {
    const children = await parentRem.getChildrenRem();
    for (const child of children) {
      const tags = await child.getTagRems();
      if (tags.some((t) => t._id === clozeExtractTag._id)) {
        clozeChildCount++;
      }
    }
  }

  const decrementsApplied = Math.min(clozeChildCount, CLOZE_DECREMENT_CAP);
  const rawPriority = parentPriority + decrementsApplied * stepSize;
  const priority = Math.max(0, Math.min(100, rawPriority));

  return {
    priority,
    parentPriority,
    parentPrioritySource,
    clozeChildCount,
    decrementsApplied,
    stepSize,
  };
}
