import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { defaultPriorityId, priorityStepSizeId } from './consts';
import { findClosestAncestorWithAnyPriority } from './priority_inheritance';
import { getIncrementalRemFromRem } from './incremental_rem';
import { CARD_PRIORITY_CODE, SOURCE_SLOT } from './card_priority/types';
import { getRawCardPriorityString } from './card_priority/slot_access';
import { getIESetting } from './settings';
import { OpTimer } from './op_timer';

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
  /** The `cloze-extract` tag, so the caller need not look it up again. Null if the KB has none yet. */
  clozeExtractTagId: string | null;
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
 * The caller must invoke this BEFORE tagging the new cloze rem, so the count reflects only
 * PRIOR clozes. An untagged new child is not counted, and it adds no card to the parent.
 *
 * Final priority = clamp(parentPriority + min(totalCount, 10) × stepSize, 0, 100).
 * Higher number = less important, so each subsequent cloze becomes less important than the previous.
 */
export async function computeClozeAutoPriority(
  plugin: RNPlugin,
  parentRem: PluginRem,
  timer?: OpTimer
): Promise<ClozeAutoPriorityInfo> {
  const track = <T,>(label: string, work: Promise<T>) => (timer ? timer.track(label, work) : work);

  // These reads are independent, so they share one wait: Alt+Z shows nothing until they finish.
  const [
    defaultPriority,
    stepSize,
    ownPriorityValue,
    ownSource,
    clozeExtractTag,
    children,
    parentOwnCardCount,
  ] = await Promise.all([
    track('settings', getIESetting(plugin, defaultPriorityId)),
    getIESetting(plugin, priorityStepSizeId),
    track('ownPriority', getRawCardPriorityString(parentRem)),
    parentRem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT),
    track('findTag', plugin.rem.findByName(['cloze-extract'], null)),
    track('children', parentRem.getChildrenRem()),
    // Native clozes inside the text plus front/back-direction cards. Falls back to 0 on error.
    track('parentCards', parentRem.getCards().then((cards) => cards?.length ?? 0).catch(() => 0)),
  ]);

  let parentPriority: number;
  let parentPrioritySource: 'incremental' | 'card-or-inherited';

  // Cloze-specific precedence: manual cardPriority wins over IncRem on the same rem.
  // Rationale: IncRem priority targets the incremental side; a manual cardPriority is a
  // deliberate user choice for the flashcard side, which is what a cloze child inherits.
  // (createExtract intentionally prefers IncRem and is unaffected.)
  //
  //   1. parentRem's own manual cardPriority.
  //   2. parentRem's own IncRem priority.
  //   3. Closest ancestor — `findClosestAncestorWithAnyPriority(..., 'Card')` prefers
  //      manual/incremental cardPriority over IncRem on the same ancestor. This is what
  //      makes the grandparent's manual cardPriority=8 win over its own IncRem=13.
  //      Note: NOT getInitialPriority, which walks with 'IncRem' precedence.
  //   4. Plugin default.
  const parsedManual =
    ownPriorityValue && ownSource === 'manual' ? parseInt(ownPriorityValue as string) : NaN;

  if (!isNaN(parsedManual)) {
    parentPriority = parsedManual;
    parentPrioritySource = 'card-or-inherited';
  } else {
    const incInfo = await track('incRem', getIncrementalRemFromRem(plugin, parentRem));
    if (incInfo) {
      parentPriority = incInfo.priority;
      parentPrioritySource = 'incremental';
    } else {
      const ancestorInfo = await track(
        'ancestors',
        findClosestAncestorWithAnyPriority(plugin, parentRem, 'Card')
      );
      if (ancestorInfo) {
        parentPriority = ancestorInfo.priority;
        parentPrioritySource = ancestorInfo.sourceType === 'IncRem' ? 'incremental' : 'card-or-inherited';
      } else {
        parentPriority = defaultPriority;
        parentPrioritySource = 'card-or-inherited';
      }
    }
  }

  // Count existing cloze-extract children (live count — robust to manual deletions)
  let clozeChildCount = 0;
  if (clozeExtractTag) {
    const childTags = await track(
      'childTags',
      Promise.all(children.map((child) => child.getTagRems()))
    );
    clozeChildCount = childTags.filter((tags) =>
      tags.some((t) => t._id === clozeExtractTag._id)
    ).length;
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
    clozeExtractTagId: clozeExtractTag?._id ?? null,
  };
}
