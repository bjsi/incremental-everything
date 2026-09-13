/**
 * Paused decks — the second card-suppression axis.
 *
 * Pausing a deck does NOT touch the cards underneath it. Measured on a live KB:
 * cards inside a paused deck keep a real `nextRepetitionTime` and therefore read
 * as DUE to everything that filters on due-ness, even though RemNote's queue
 * refuses to serve them (the document's own badge says "0 Due"). That is why the
 * Priority Review Document had to grow its own paused check, and why counting
 * "unscheduled" cards is not enough to describe what can actually be practised.
 *
 * Detection is top-down. Walking up from every card-owning Rem is not viable —
 * a 72k-card KB has ~45k distinct card-owning Rems, so that is 45k+ round trips.
 * Finding the handful of paused decks and asking each one for its descendants is
 * one call per deck.
 *
 * Finding the decks is the awkward part: `taggedRem()` silently under-reports
 * membership for RemNote's BUILT-IN powerups, so the Deck powerup cannot be
 * enumerated directly. The scan therefore walks `plugin.rem.getAll()` and probes
 * with `hasPowerup`, filtered first on the synchronous snapshot field `children`
 * (a deck always has children) so only a small fraction of the KB costs a read.
 * The result is cached in session storage — it is a per-session fact, not a
 * per-export one.
 */

import { BuiltInPowerupCodes, RemId, RNPlugin } from '@remnote/plugin-sdk';
import { pausedDeckScanKey } from './consts';
import { safeRemTextToString } from './pdfUtils';

/** How many powerup probes are kept in flight. Reads overlap fine; writes don't. */
const READ_CONCURRENCY = 16;

export interface PausedDeck {
  remId: RemId;
  text: string;
  /** Descendant Rems, excluding the deck Rem itself. */
  descendants: number;
}

export interface PausedDeckScan {
  /** Every Rem in the KB the scan looked at. */
  scannedRems: number;
  /** Survivors of the cheap snapshot filter — the ones that cost a read. */
  candidates: number;
  /** Candidates that actually carry the Deck powerup. */
  deckRems: number;
  pausedDecks: PausedDeck[];
  /** Paused deck Rems plus all their descendants. Cards on these are suppressed. */
  suppressedRemIds: RemId[];
  /** Deck ids the caller supplied manually, merged into the result. */
  manualDeckIds: RemId[];
  scannedAt: number;
  durationMs: number;
}

/**
 * Full KB scan for paused decks. Expensive (one pass over every Rem plus a
 * bounded number of powerup reads), so callers should prefer `getPausedRemIds`,
 * which serves the cached result.
 *
 * `manualDeckIds` are treated as paused decks without probing — an escape hatch
 * for a deck the scan cannot see, and for testing.
 */
export async function scanPausedDecks(
  plugin: RNPlugin,
  opts: {
    manualDeckIds?: RemId[];
    onProgress?: (done: number, total: number, phase: string) => void;
  } = {},
): Promise<PausedDeckScan> {
  const started = Date.now();
  const { manualDeckIds = [], onProgress } = opts;

  onProgress?.(0, 0, 'Loading Rems…');
  const allRems = (await plugin.rem.getAll()) || [];

  // Cheap snapshot filter: a deck has children. Decided from `parent`, not from
  // `children`: the bridge fills `children` from RemNote's lazy child cache,
  // which is empty for every document not opened this session — so a paused
  // deck nobody had opened was never probed, and its cards counted as due in
  // the shields and the Priority Queue. getAll() loads the whole database and
  // every Rem carries its parent, so "some Rem names it as parent" is complete
  // and still costs no round trip. See priority_review_document/children.ts.
  const hasChildren = new Set<string>();
  for (const r of allRems as any[]) if (r.parent) hasChildren.add(r.parent);
  const candidates = allRems.filter((r: any) => hasChildren.has(r._id));

  const deckRems: any[] = [];
  const pausedRems: any[] = [];
  let done = 0;

  await mapWithConcurrency(candidates, READ_CONCURRENCY, async (rem: any) => {
    try {
      if (await rem.hasPowerup(BuiltInPowerupCodes.Deck)) {
        deckRems.push(rem);
        const status = await rem.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
        if (status === 'Paused') pausedRems.push(rem);
      }
    } catch {
      /* a Rem that cannot be probed simply isn't counted as a deck */
    }
    done++;
    if (done % 500 === 0) onProgress?.(done, candidates.length, 'Probing decks…');
  });

  // Merge in manually supplied decks that the probe did not already find.
  const foundIds = new Set(pausedRems.map((r) => r._id));
  for (const id of manualDeckIds) {
    if (foundIds.has(id)) continue;
    const rem = await plugin.rem.findOne(id);
    if (rem) {
      pausedRems.push(rem);
      foundIds.add(id);
    }
  }

  onProgress?.(0, pausedRems.length, 'Expanding paused decks…');
  const suppressed = new Set<RemId>();
  const pausedDecks: PausedDeck[] = [];

  for (let i = 0; i < pausedRems.length; i++) {
    const deck = pausedRems[i];
    suppressed.add(deck._id);
    let descendants: any[] = [];
    try {
      descendants = (await deck.getDescendants()) || [];
    } catch {
      /* keep the deck itself even if the subtree cannot be expanded */
    }
    for (const d of descendants) suppressed.add(d._id);
    pausedDecks.push({
      remId: deck._id,
      text: await safeRemTextToString(plugin, deck.text),
      descendants: descendants.length,
    });
    onProgress?.(i + 1, pausedRems.length, 'Expanding paused decks…');
  }

  const scan: PausedDeckScan = {
    scannedRems: allRems.length,
    candidates: candidates.length,
    deckRems: deckRems.length,
    pausedDecks: pausedDecks.sort((a, b) => b.descendants - a.descendants),
    suppressedRemIds: Array.from(suppressed),
    manualDeckIds,
    scannedAt: Date.now(),
    durationMs: Date.now() - started,
  };

  // Session for this run, local so the next session's startup paths (the card
  // priority cache, which builds long before any scan could run) can apply it
  // for the price of one read.
  await plugin.storage.setSession(pausedDeckScanKey, scan);
  await plugin.storage.setLocal(pausedDeckScanKey, scan).catch(() => {});
  return scan;
}

/**
 * The cached scan: this session's if present, otherwise the last one persisted
 * locally. The local copy is what lets startup paths apply the pause without
 * paying for a scan they cannot afford to run.
 */
export async function getCachedPausedDeckScan(plugin: RNPlugin): Promise<PausedDeckScan | null> {
  const session = await plugin.storage.getSession<PausedDeckScan>(pausedDeckScanKey);
  if (session) return session;
  try {
    return (await plugin.storage.getLocal<PausedDeckScan>(pausedDeckScanKey)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Rem ids whose cards are suppressed by a paused deck, from the cached scan.
 * Returns null when no scan has run — callers must distinguish "no paused decks"
 * from "we never looked", because reporting zero for the second is how a whole
 * suppressed deck ends up counted as due.
 */
export async function getPausedRemIds(plugin: RNPlugin): Promise<Set<RemId> | null> {
  const scan = await getCachedPausedDeckScan(plugin);
  if (!scan) return null;
  return new Set(scan.suppressedRemIds);
}

/** Runs `task` over `items` with a bounded number in flight. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
}
