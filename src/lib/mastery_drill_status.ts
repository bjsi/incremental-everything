import { QueueInteractionScore, RNPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  disableFinalDrillNotificationId,
  enableMasteryDrillId,
  masteryDrillHardIntervalPercentId,
  masteryDrillHardMaxDaysId,
  masteryDrillMinDelayMinutesId,
} from './consts';
import { getIESetting, useIESetting } from './settings';
import {
  DrillCooling,
  FinalDrillEntry,
  MINUTE_MS,
  isDrillEntryCooling,
  returnsAtOnce,
  toCooling,
} from './mastery_drill_cooling';

/**
 * "Is there a Mastery Drill worth offering right now?", in one place.
 *
 * This used to live inside `widgets/mastery_drill_notification.tsx`, which made
 * it unreachable from anywhere else — and the hub's collapsed icon row needs
 * exactly the same answer to decide whether to show 🎯 and what number to put
 * on it. Two copies of this would drift the moment either threshold moved, and
 * the user would get an icon promising cards the drill then refuses to hand
 * over.
 */

export type { DrillCooling, FinalDrillEntry } from './mastery_drill_cooling';
export {
  drillCoolingMs,
  drillReadyAt,
  formatDrillWait,
  isDrillEntryCooling,
} from './mastery_drill_cooling';

/** A Hard rating older than this is not the one that just put the card in the drill. */
const FRESH_RATING_MS = 5 * MINUTE_MS;

export async function getDrillCooling(plugin: RNPlugin): Promise<DrillCooling> {
  return toCooling(
    await getIESetting(plugin, masteryDrillMinDelayMinutesId),
    await getIESetting(plugin, masteryDrillHardIntervalPercentId),
    await getIESetting(plugin, masteryDrillHardMaxDaysId)
  );
}

export function useDrillCooling(): DrillCooling {
  const minDelayMinutes = useIESetting(masteryDrillMinDelayMinutesId);
  const hardPercent = useIESetting(masteryDrillHardIntervalPercentId);
  const hardMaxDays = useIESetting(masteryDrillHardMaxDaysId);
  return React.useMemo(
    () => toCooling(minDelayMinutes, hardPercent, hardMaxDays),
    [minDelayMinutes, hardPercent, hardMaxDays]
  );
}

/** Whether a card just rated Again/Hard may come straight back into the same drill session. */
export const ratingReturnsAtOnce = (score: QueueInteractionScore | undefined, c: DrillCooling) =>
  returnsAtOnce(score === QueueInteractionScore.HARD, c);

/**
 * The drill entry for a card just rated Again or Hard. For Hard it reads the new
 * interval off the card: RemNote writes the rating and the next due date
 * together. If the card's last rating is not that fresh Hard one, the interval
 * is left out and the card gets the Minimum Delay, as before.
 */
export async function buildDrillEntry(
  plugin: RNPlugin,
  cardId: string,
  kbId: string | undefined,
  score: QueueInteractionScore,
  addedAt = Date.now()
): Promise<Exclude<FinalDrillEntry, string>> {
  const entry: Exclude<FinalDrillEntry, string> = { cardId, kbId, addedAt };
  if (score !== QueueInteractionScore.HARD) return entry;
  try {
    const card = await plugin.card.findOne(cardId);
    const history = card?.repetitionHistory ?? [];
    let rep: { score: QueueInteractionScore; date: number } | undefined;
    for (let i = history.length - 1; i >= 0 && !rep; i--) {
      if (history[i].score !== QueueInteractionScore.TOO_EARLY) rep = history[i];
    }
    const next = card?.nextRepetitionTime;
    if (rep?.score === QueueInteractionScore.HARD && Math.abs(addedAt - rep.date) <= FRESH_RATING_MS && next && next > rep.date) {
      entry.intervalMs = next - rep.date;
    }
  } catch (e) {
    console.warn('[MasteryDrill] could not read the Hard interval of', cardId, e);
  }
  return entry;
}

/** Session key the drill sets to re-open the notification after a partial run. */
export const finalDrillResumeTriggerKey = 'finalDrillResumeTrigger';

/** Synced key holding the queued cards. */
export const finalDrillIdsKey = 'finalDrillIds';

/**
 * Below this, the drill is not worth interrupting anyone for: a handful of
 * lapsed cards will come round in the normal queue soon enough, and a panel
 * that appears for three cards trains the user to ignore it.
 */
export const MIN_QUEUE_SIZE_FOR_NOTIFICATION = 10;

export interface MasteryDrillStatus {
  /**
   * The Mastery Drill feature itself is switched on. Worth checking from the
   * hub, which is always mounted: the drill's own widgets are only registered
   * when this is true, so its notification never had to ask.
   */
  enabled: boolean;
  /** The user switched the notification off in settings. */
  disabled: boolean;
  /** Everything queued for this knowledge base, ready or not. */
  count: number;
  /** Those past their cooling — the number actually drillable now. */
  readyCount: number;
}

/**
 * Reads the drill queue for the *current* knowledge base and ages it against
 * each entry's cooling (see DrillCooling).
 *
 * Call it inside a `useTrackerPlugin` to have it re-run when the queue or the
 * settings change.
 */
export async function getMasteryDrillStatus(
  plugin: RNPlugin
): Promise<MasteryDrillStatus> {
  const enabled = await getIESetting(plugin, enableMasteryDrillId);
  const disabled = await getIESetting(plugin, disableFinalDrillNotificationId);
  const cooling = await getDrillCooling(plugin);
  const ids =
    ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];

  const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
  const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
  const currentKbId = currentKb?._id;

  const relevantItems = ids.filter((item) =>
    typeof item === 'string' ? isPrimary : item.kbId === currentKbId
  );

  const now = Date.now();
  let readyCount = 0;
  for (const item of relevantItems) {
    if (!isDrillEntryCooling(item, cooling, now)) readyCount++;
  }

  return { enabled, disabled, count: relevantItems.length, readyCount };
}

/**
 * Whether the drill should be offered at all. `undefined` is the pre-load
 * state — offer nothing rather than flashing an icon in and out.
 */
export function masteryDrillIsReady(
  status: MasteryDrillStatus | undefined | null
): status is MasteryDrillStatus {
  return (
    !!status &&
    status.enabled &&
    !status.disabled &&
    status.readyCount >= MIN_QUEUE_SIZE_FOR_NOTIFICATION
  );
}
