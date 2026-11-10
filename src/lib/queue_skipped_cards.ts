/**
 * Cards a plugin module removed from the queue as they loaded: the regular-queue Mastery Drill
 * (cards not ready for the drill), cooling and Recognition First (both through
 * claimCardRemoval in queue_cooling_skip.ts). RemNote loads each one and fires QueueLoadCard,
 * but the user never sees it, so the Live Session must not count it as the previous card.
 *
 * A skip is kept with its time: the same card may load again later and stay on screen, so a
 * reader asks whether it was skipped since its latest load, not whether it was ever skipped.
 */
const MAX_KEPT = 200;
/**
 * The drill marks a card in the same QueueLoadCard dispatch that times its load elsewhere, and
 * listener order is not guaranteed, so its mark may read a few ms earlier than the load time.
 * A skipped card cannot load again and stay within this window: the skip alone takes ~350 ms.
 */
const SAME_LOAD_SLACK_MS = 250;
const skippedAt = new Map<string, number>();

/** Call before the removal: the next card can load before removeCurrentCardFromQueue resolves. */
export function noteCardSkipped(cardId: string): void {
  skippedAt.delete(cardId);
  skippedAt.set(cardId, Date.now());
  if (skippedAt.size > MAX_KEPT) {
    const oldest = skippedAt.keys().next().value;
    if (oldest !== undefined) skippedAt.delete(oldest);
  }
}

/** The removal failed, so the card stayed on screen. */
export function forgetCardSkip(cardId: string): void {
  skippedAt.delete(cardId);
}

/** Whether the card was skipped at or after `loadedAt`, the time its current load arrived. */
export function wasCardSkippedSince(cardId: string, loadedAt: number): boolean {
  const at = skippedAt.get(cardId);
  return at !== undefined && at >= loadedAt - SAME_LOAD_SLACK_MS;
}
