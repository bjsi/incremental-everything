import { BuiltInPowerupCodes, RNPlugin } from '@remnote/plugin-sdk';
import { getCardPriority } from './card_priority';
import { DrillCooling, FinalDrillEntry, isOldDrillEntry } from './mastery_drill_cooling';
import { finalDrillIdsKey } from './mastery_drill_status';

/**
 * What the two Mastery Drill headers do to the drill list — the popup drill and the
 * regular-queue drill's bar. Each reads the synced list fresh before writing, so a
 * rating recorded a moment earlier by the event handlers is not overwritten.
 */

const entryCardId = (item: FinalDrillEntry) => (typeof item === 'string' ? item : item.cardId);

async function readList(plugin: RNPlugin): Promise<FinalDrillEntry[]> {
  return ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];
}

/** Takes these cards out of the drill. Returns how many were in it. */
export async function removeFromDrill(plugin: RNPlugin, cardIds: Iterable<string>): Promise<number> {
  const ids = new Set(cardIds);
  const items = await readList(plugin);
  const kept = items.filter((item) => !ids.has(entryCardId(item)));
  if (kept.length !== items.length) await plugin.storage.setSynced(finalDrillIdsKey, kept);
  return items.length - kept.length;
}

/** Empties the drill for this knowledge base. Legacy string entries belong to the primary KB. */
export async function clearDrillForKb(plugin: RNPlugin, kbId: string, isPrimary: boolean): Promise<void> {
  const items = await readList(plugin);
  await plugin.storage.setSynced(
    finalDrillIdsKey,
    items.filter((item) => (typeof item === 'string' ? !isPrimary : item.kbId !== kbId))
  );
}

/** Removes this knowledge base's entries that have been ready for longer than the threshold. */
export async function clearOldDrillItems(
  plugin: RNPlugin,
  kbId: string,
  cooling: DrillCooling,
  thresholdDays: number
): Promise<void> {
  const now = Date.now();
  const items = await readList(plugin);
  await plugin.storage.setSynced(
    finalDrillIdsKey,
    items.filter((item) => !(typeof item !== 'string' && item.kbId === kbId && isOldDrillEntry(item, cooling, thresholdDays, now)))
  );
}

/** Tags the card's Rem Edit Later with this note and takes the card out of the drill. */
export async function markDrillCardEditLater(plugin: RNPlugin, cardId: string, message: string): Promise<boolean> {
  const card = await plugin.card.findOne(cardId);
  const rem = card?.remId ? await plugin.rem.findOne(card.remId) : undefined;
  if (!rem) return false;
  await rem.addPowerup(BuiltInPowerupCodes.EditLater);
  await rem.setPowerupProperty(BuiltInPowerupCodes.EditLater, 'Message', [message.trim() || 'Mastery Drill']);
  await removeFromDrill(plugin, [cardId]);
  return true;
}

/** Each entry's card priority, for the Clear Low Priority view. Cards without a Rem are left out. */
export async function readDrillPriorities(
  plugin: RNPlugin,
  items: FinalDrillEntry[],
  isCancelled: () => boolean = () => false
): Promise<{ cardId: string; priority: number }[]> {
  const results: { cardId: string; priority: number }[] = [];
  for (const item of items) {
    if (isCancelled()) break;
    const cardId = entryCardId(item);
    const card = await plugin.card.findOne(cardId);
    const rem = card?.remId ? await plugin.rem.findOne(card.remId) : undefined;
    if (!rem) continue;
    const info = await getCardPriority(plugin, rem);
    results.push({ cardId, priority: info?.priority ?? 100 });
  }
  return results;
}

/**
 * Takes the card off the live queue if it is the one RemNote reports on screen.
 * Inside a Card Cluster RemNote reports the anchor, so a sibling is left alone
 * (removing the anchor would drop the whole cluster); it goes once rated.
 */
export async function dropFromLiveQueue(plugin: RNPlugin, cardId: string): Promise<boolean> {
  const live = await plugin.queue.getCurrentCard();
  if (live?._id !== cardId) return false;
  await plugin.queue.removeCurrentCardFromQueue(false);
  return true;
}
