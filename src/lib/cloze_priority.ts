import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { defaultPriorityId, priorityStepSizeId } from './consts';
import { getInitialPriority } from './priority_inheritance';
import { getIncrementalRemFromRem } from './incremental_rem';

// Cap on how many step-size decrements (= priority-number increments)
// can be auto-applied to a new cloze. Even on the 12th cloze, we apply 10 steps.
export const CLOZE_DECREMENT_CAP = 10;

export interface ClozeAutoPriorityInfo {
  /** Final card priority to assign to the new cloze rem (clamped to [0, 100]). */
  priority: number;
  /** The parent extract's resolved priority. */
  parentPriority: number;
  /** Where the parent's priority came from (for the widget label). */
  parentPrioritySource: 'incremental' | 'card-or-inherited';
  /** Number of existing #cloze-extract children of the parent (excluding the new cloze). */
  clozeChildCount: number;
  /**
   * Number of cards the parent rem already owns itself — native cloze markers
   * inside its text plus front/back-direction cards if it is a flashcard.
   * Does NOT include children's cards.
   */
  parentOwnCardCount: number;
  /** clozeChildCount + parentOwnCardCount. Drives the decrement count. */
  totalExistingCount: number;
  /** min(totalExistingCount, CLOZE_DECREMENT_CAP). */
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
 * Existing-card count combines:
 *   - cloze-extract children of the parent (clozes already extracted from it as siblings
 *     of the new cloze), and
 *   - cards the parent rem owns itself — native cloze markers inside its text plus
 *     front/back-direction cards if it is a flashcard. Counted via `parentRem.getCards()`,
 *     which does NOT include descendants' cards, so there's no double-counting with the
 *     cloze-extract children.
 *
 * The caller must invoke this BEFORE creating/parenting the new cloze rem, so the count
 * reflects only PRIOR clozes (not the one about to be created).
 *
 * Final priority = clamp(parentPriority + min(totalCount, 10) × stepSize, 0, 100).
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

  // Count cards the parent rem already owns itself — native clozes inside its text plus
  // front/back-direction cards if it is a flashcard. Safely fall back to 0 on error.
  let parentOwnCardCount = 0;
  try {
    const parentCards = await parentRem.getCards();
    parentOwnCardCount = parentCards?.length ?? 0;
  } catch {
    parentOwnCardCount = 0;
  }

  const totalExistingCount = clozeChildCount + parentOwnCardCount;
  const decrementsApplied = Math.min(totalExistingCount, CLOZE_DECREMENT_CAP);
  const rawPriority = parentPriority + decrementsApplied * stepSize;
  const priority = Math.max(0, Math.min(100, rawPriority));

  return {
    priority,
    parentPriority,
    parentPrioritySource,
    clozeChildCount,
    parentOwnCardCount,
    totalExistingCount,
    decrementsApplied,
    stepSize,
  };
}
