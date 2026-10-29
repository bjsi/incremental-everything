import { RemId, RNPlugin } from '@remnote/plugin-sdk';
import { pendingCardPriorityKey } from '../consts';
import { PrioritySource } from './types';

/**
 * The card priority a popup just saved, published for the displays that read the
 * card-priority cache (card info bar, queue priority badge).
 *
 * Why it exists: the popup closes at once and leaves the writes to the tracker,
 * which reaches the cache only after the slot writes and a full read + rewrite of
 * the ~8MB cache — seconds, during which those displays still showed the old
 * value. The popup cannot patch the cache itself: that needs a read first, and
 * the reply arrives after the popup's iframe is gone. A single setSession is
 * posted immediately and survives the teardown, so this key can be written.
 *
 * One slot, not a map: writing a map would need the same read-before-write. A
 * later save overwrites an earlier one, which only matters if two rems are
 * changed within the few seconds the tracker needs — and then the earlier one
 * falls back to the cache, as before.
 *
 * Never cleared by the tracker: clearing it would race the displays' own (slow)
 * cache re-read and flash the old value. Readers drop it themselves once the
 * value they hold is at least as new (see {@link pendingCardPriorityFor}).
 */
export interface PendingCardPriority {
  remId: RemId;
  priority: number;
  source: PrioritySource;
  /** When the popup saved it. The tracker's slot write stamps a later lastUpdated. */
  at: number;
}

/**
 * How long a pending value is trusted without the cache catching up. Only reached
 * when the tracker job failed — normally the cache's newer lastUpdated retires
 * the entry within seconds.
 */
const PENDING_CARD_PRIORITY_TTL_MS = 120_000;

/** Fire-and-forget on purpose: callers write this right before closePopup. */
export function publishPendingCardPriority(
  plugin: RNPlugin,
  remId: RemId,
  priority: number,
  source: PrioritySource
): void {
  const entry: PendingCardPriority = { remId, priority, source, at: Date.now() };
  plugin.storage.setSession(pendingCardPriorityKey, entry).catch(console.error);
}

/**
 * The pending value for `remId`, or null when there is none or `base` (what the
 * display read from the cache or the Rem) has already caught up with it.
 */
export function pendingCardPriorityFor(
  pending: PendingCardPriority | null | undefined,
  remId: RemId | undefined,
  base: { lastUpdated?: number } | null | undefined
): PendingCardPriority | null {
  if (!pending || !remId || pending.remId !== remId) return null;
  if (Date.now() - pending.at > PENDING_CARD_PRIORITY_TTL_MS) return null;
  if ((base?.lastUpdated ?? 0) >= pending.at) return null;
  return pending;
}
