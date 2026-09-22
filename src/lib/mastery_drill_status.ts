import { RNPlugin } from '@remnote/plugin-sdk';
import {
  disableFinalDrillNotificationId,
  enableMasteryDrillId,
  masteryDrillMinDelayMinutesId,
} from './consts';
import { getIESetting } from './settings';

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

/**
 * An entry in the synced `finalDrillIds` list. The bare-string form is the
 * legacy shape, written before the list carried its knowledge base: it belongs
 * to the primary KB and has no age, so it is always considered ready.
 */
export type FinalDrillEntry =
  | string
  | { cardId: string; kbId?: string; addedAt?: number };

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
  /** Those past the minimum delay — the number actually drillable now. */
  readyCount: number;
}

/**
 * Reads the drill queue for the *current* knowledge base and ages it against
 * the configured minimum delay.
 *
 * Call it inside a `useTrackerPlugin` to have it re-run when the queue or the
 * settings change.
 */
export async function getMasteryDrillStatus(
  plugin: RNPlugin
): Promise<MasteryDrillStatus> {
  const enabled = await getIESetting(plugin, enableMasteryDrillId);
  const disabled = await getIESetting(plugin, disableFinalDrillNotificationId);
  const minDelayMinutes = await getIESetting(plugin, masteryDrillMinDelayMinutesId);
  const ids =
    ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];

  const currentKb = await plugin.kb.getCurrentKnowledgeBaseData();
  const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
  const currentKbId = currentKb?._id;

  const relevantItems = ids.filter((item) =>
    typeof item === 'string' ? isPrimary : item.kbId === currentKbId
  );

  const now = Date.now();
  const minDelayMs = minDelayMinutes * 60 * 1000;
  let readyCount = 0;
  for (const item of relevantItems) {
    const addedAt = typeof item === 'string' ? undefined : item.addedAt;
    if (!addedAt || now - addedAt >= minDelayMs) readyCount++;
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
