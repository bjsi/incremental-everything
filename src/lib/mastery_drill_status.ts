import { Card, PluginRem, QueueInteractionScore, RNPlugin } from '@remnote/plugin-sdk';
import React from 'react';
import {
  disableFinalDrillNotificationId,
  enableMasteryDrillId,
  masteryDrillHardIntervalPercentId,
  masteryDrillHardMaxDaysId,
  masteryDrillMaxPriorityId,
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
 * Whether a card of this Rem may enter the drill, per the Priority Cap. Reads the
 * priority only when the cap is set below 100. A Rem that cannot be read is let in.
 */
export async function drillAcceptsRem(plugin: RNPlugin, rem: PluginRem | null | undefined): Promise<boolean> {
  const cap = Number(await getIESetting(plugin, masteryDrillMaxPriorityId));
  if (!Number.isFinite(cap) || cap >= 100 || !rem) return true;
  try {
    // Loaded here, not at the top: the card-priority module drags in most of the SDK's
    // built-in tables, and this file is imported by node tests (cluster_rating_readback).
    const { getCardPriorityValue } = await import('./card_priority');
    return (await getCardPriorityValue(plugin, rem)) <= cap;
  } catch (e) {
    console.warn('[MasteryDrill] could not read the priority of', rem._id, e);
    return true;
  }
}

/**
 * The drill entry for a card just rated Again or Hard, or null when the Priority Cap
 * keeps the card out of the drill.
 *
 * It reads the interval the rating gave off the card: RemNote writes the rating and
 * the next due date together. For Hard it is the new interval (intervalMs); for Again
 * it is the scheduler's relearning step (relearnMs), which the card waits out when it
 * is longer than the Minimum Delay. If the card's last rating is not that fresh one,
 * the interval is left out and the card gets the Minimum Delay, as before.
 */
export async function buildDrillEntry(
  plugin: RNPlugin,
  cardId: string,
  kbId: string | undefined,
  score: QueueInteractionScore,
  addedAt = Date.now()
): Promise<Exclude<FinalDrillEntry, string> | null> {
  const entry: Exclude<FinalDrillEntry, string> = { cardId, kbId, addedAt };
  let card: Card | undefined;
  try {
    card = await plugin.card.findOne(cardId);
  } catch (e) {
    console.warn('[MasteryDrill] could not read card', cardId, e);
  }
  if (card?.remId && !(await drillAcceptsRem(plugin, await plugin.rem.findOne(card.remId)))) {
    console.log(`[MasteryDrill] ${cardId} not sent to the drill: its priority is below the Priority Cap.`);
    return null;
  }
  const interval = freshRatingInterval(card, score, addedAt);
  if (interval !== undefined) {
    if (score === QueueInteractionScore.HARD) entry.intervalMs = interval;
    else if (score === QueueInteractionScore.AGAIN) entry.relearnMs = interval;
  }
  return entry;
}

/**
 * The interval this rating gave the card (next due date minus the rating), when the
 * card's last real rating is this score and was made around `addedAt`.
 */
function freshRatingInterval(card: Card | undefined, score: QueueInteractionScore, addedAt: number): number | undefined {
  const history = card?.repetitionHistory ?? [];
  let rep: { score: QueueInteractionScore; date: number } | undefined;
  for (let i = history.length - 1; i >= 0 && !rep; i--) {
    if (history[i].score !== QueueInteractionScore.TOO_EARLY) rep = history[i];
  }
  const next = card?.nextRepetitionTime;
  if (rep?.score === score && Math.abs(addedAt - rep.date) <= FRESH_RATING_MS && next && next > rep.date) {
    return next - rep.date;
  }
  return undefined;
}

/**
 * Gives the Again entries written before relearnMs existed their relearning step, read
 * from each card. Once per knowledge base; entries of other knowledge bases are left
 * alone (their cards can't be read from here).
 */
export async function backfillDrillRelearnSteps(plugin: RNPlugin): Promise<void> {
  const kbId = (await plugin.kb.getCurrentKnowledgeBaseData())?._id;
  if (!kbId) return;
  const doneKey = `finalDrillRelearnBackfill_${kbId}`;
  if (await plugin.storage.getSynced(doneKey)) return;
  const items = ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];
  const found = new Map<string, number>();
  for (const item of items) {
    if (typeof item === 'string' || item.kbId !== kbId || !item.addedAt || item.intervalMs || item.relearnMs) continue;
    try {
      const interval = freshRatingInterval(await plugin.card.findOne(item.cardId), QueueInteractionScore.AGAIN, item.addedAt);
      if (interval) found.set(`${item.cardId}@${item.addedAt}`, interval);
    } catch {
      // A card that can't be read keeps the Minimum Delay.
    }
  }
  if (found.size > 0) {
    // Read again: a rating may have changed the list while the cards were read.
    const latest = ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];
    await plugin.storage.setSynced(
      finalDrillIdsKey,
      latest.map((item) => {
        if (typeof item === 'string') return item;
        const relearnMs = found.get(`${item.cardId}@${item.addedAt}`);
        return relearnMs && !item.relearnMs ? { ...item, relearnMs } : item;
      })
    );
  }
  await plugin.storage.setSynced(doneKey, Date.now());
  console.log(`[MasteryDrill] relearning steps read for ${found.size} Again entries.`);
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
