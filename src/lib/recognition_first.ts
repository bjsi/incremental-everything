import { AppEvents, PluginRem, RemId, RemType, RNPlugin } from '@remnote/plugin-sdk';
import { recognitionFirstHeldKeyPrefix, recognitionFirstId, recognitionFirstMinDaysId } from './consts';
import { getIESetting } from './settings';
import { queueRouteKind } from './queue_route';
import { claimCardRemoval } from './queue_cooling_skip';
import { getKbId } from './priority_review_document/cooling_store';
import { hasCardClusterPowerup } from './priority_review_document/cluster';
import { hasBeenReviewed, isPassingScore, recognitionPassed, shouldHoldForward } from './recognition_first_rules';

/**
 * Recognition First: a new bidirectional concept is learned back → front (description → name)
 * before front → back. RemNote serves the two in random order
 * (findings/QUEUE_AND_PRACTICE.md), and a plugin skip alone cannot fix that: skipping the front →
 * back card buries the back → front one for an hour.
 *
 * So the Rem practises back → front only until that card is passed:
 *   - Hold: when a never-reviewed concept card loads in a spaced or Learn New queue, the Rem is
 *     set to 'backward' and remembered in a synced list. A front → back card on screen is removed
 *     first, because the flash would show the name that the other card asks for. Its back → front
 *     card is then buried for up to an hour, on this first contact only.
 *   - Release: the first Good or Easy on the back → front card (with its interval at least the
 *     setting's days) sets the Rem back to 'both'. A held front → back card has no reps, so
 *     RemNote drops its record on hold and writes a new one, due at once, on release (measured
 *     2026-10-31); nothing is lost. The bury and, where on, cooling keep it away for a while.
 *   - Catch up: at queue start, a sample of held Rems is checked, for ratings this index missed
 *     (another device, a Card Cluster). With the setting off, all held Rems are released.
 *
 * Only Rems in the list are ever released. A held Rem whose direction the user changed drops off
 * the list untouched, which is also how a single Rem is released by hand.
 */

const LOG = '[RecognitionFirst]';
const MAX_LOADS_PER_CARD = 6;
/** A card's history lags its rating: read after this long (cluster_rating_readback.ts measured the same). */
const RATING_READ_DELAY_MS = 1500;
const SWEEP_DELAY_MS = 8000;
const SWEEP_SAMPLE = 100;
const SWEEP_CONCURRENCY = 4;
const SWEEP_MIN_GAP_MS = 10 * 60_000;

type HeldRems = Record<RemId, number>;

interface Session {
  path: string;
  minDays: number;
  /** The card on screen, cleared once it is rated: a removal must never take the next one. */
  currentCardId: string | null;
  loadsByCard: Map<string, number>;
  /**
   * The front → back cards this session's holds deleted. The queue's loaded batch keeps them and
   * still serves them, after Keep Practicing for one (measured 2026-10-31: loads with ids found
   * only in deleted_cards). They are recognised by id, with no read.
   */
  deletedForwardCards: Set<string>;
  toastShown: boolean;
}

let session: Session | null = null;
let entering: Promise<void> = Promise.resolve();
let held: HeldRems = {};
/** Read-modify-write of the synced list, one at a time: another device may have changed it. */
let listWrites: Promise<unknown> = Promise.resolve();
let lastSweepAt = 0;

const heldKey = async (plugin: RNPlugin) => `${recognitionFirstHeldKeyPrefix}_${await getKbId(plugin)}`;

async function readHeld(plugin: RNPlugin): Promise<HeldRems> {
  return (await plugin.storage.getSynced<HeldRems>(await heldKey(plugin))) ?? {};
}

function updateHeld(plugin: RNPlugin, change: (list: HeldRems) => void): Promise<void> {
  const write = listWrites.then(async () => {
    const list = await readHeld(plugin);
    change(list);
    held = list;
    await plugin.storage.setSynced(await heldKey(plugin), list);
  });
  listWrites = write.catch((e) => console.warn(`${LOG} could not save the held list:`, e));
  return write;
}

/** A Card Cluster is shown as one unit: its members keep the directions they have. */
async function inCardCluster(plugin: RNPlugin, rem: PluginRem): Promise<boolean> {
  const parent = rem.parent ? await plugin.rem.findOne(rem.parent as RemId) : null;
  return parent ? hasCardClusterPowerup(plugin, parent) : false;
}

/** The card is on screen and nothing else claimed it: it leaves without showing longer. */
async function removeFromQueue(plugin: RNPlugin, s: Session, cardId: string): Promise<boolean> {
  if (session !== s || s.currentCardId !== cardId || !claimCardRemoval(cardId)) return false;
  await plugin.queue.removeCurrentCardFromQueue(false);
  if (!s.toastShown) {
    s.toastShown = true;
    void plugin.app.toast('Recognition First: this concept starts with recognizing the term; defining it comes later.');
  }
  return true;
}

async function checkCard(plugin: RNPlugin, s: Session, cardId: string): Promise<void> {
  const card = await plugin.card.findOne(cardId);
  if (!card || (card.type !== 'forward' && card.type !== 'backward')) return;
  // Nearly every card in a queue stops here, on the one read.
  if (hasBeenReviewed(card)) return;
  const remId = card.remId as RemId;

  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;

  if (held[remId] !== undefined) {
    if (card.type !== 'forward') return;
    // A guard: the record is normally gone by now, and findOne above returns nothing for it.
    if ((await rem.getPracticeDirection()) !== 'backward') {
      await updateHeld(plugin, (list) => delete list[remId]);
      return;
    }
    if (await removeFromQueue(plugin, s, cardId)) console.log(`${LOG} skipped the front → back card of a held Rem (${remId})`);
    return;
  }

  if (rem.type !== RemType.CONCEPT) return;
  if ((await rem.getPracticeDirection()) !== 'both') return;
  const cards = await rem.getCards();
  if (!shouldHoldForward(cards, s.minDays)) return;
  if (await inCardCluster(plugin, rem)) return;

  const forward = cards.find((c) => c.type === 'forward');
  if (forward) s.deletedForwardCards.add(forward._id);

  const skipped = card.type === 'forward' && (await removeFromQueue(plugin, s, cardId));
  // Listed first: a Rem left 'backward' off the list could never be released.
  await updateHeld(plugin, (list) => {
    list[remId] = Date.now();
  });
  await rem.setPracticeDirection('backward');
  console.log(`${LOG} holding Rem ${remId}: loaded ${card.type}${skipped ? ', removed from the queue' : ''}`);
}

/** Drops a Rem the user changed or deleted, and releases one whose back → front card has passed. */
async function reviewHeldRem(plugin: RNPlugin, remId: RemId, minDays: number, force = false): Promise<boolean> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem || (await rem.getPracticeDirection()) !== 'backward') {
    await updateHeld(plugin, (list) => delete list[remId]);
    console.log(`${LOG} Rem ${remId} is off the list: ${rem ? 'its direction was changed' : 'it no longer exists'}`);
    return false;
  }
  if (!force) {
    const backward = (await rem.getCards()).find((card) => card.type === 'backward');
    if (!backward || !recognitionPassed(backward, minDays)) return false;
  }
  await rem.setPracticeDirection('both');
  await updateHeld(plugin, (list) => delete list[remId]);
  console.log(`${LOG} released Rem ${remId}${force ? ' by request' : ''}`);
  return true;
}

async function onRating(plugin: RNPlugin, cardId: string, score: unknown) {
  if (!isPassingScore(score) || Object.keys(held).length === 0) return;
  const card = await plugin.card.findOne(cardId);
  if (!card || card.type !== 'backward' || held[card.remId as RemId] === undefined) return;
  const minDays = await getIESetting(plugin, recognitionFirstMinDaysId);
  setTimeout(() => {
    reviewHeldRem(plugin, card.remId as RemId, minDays).catch((e) => console.warn(`${LOG} release failed:`, e));
  }, RATING_READ_DELAY_MS);
}

function sampleOf<T>(items: T[], size: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, size);
}

async function reviewMany(plugin: RNPlugin, remIds: RemId[], minDays: number, force: boolean): Promise<number> {
  let released = 0;
  for (let i = 0; i < remIds.length; i += SWEEP_CONCURRENCY) {
    const results = await Promise.all(
      remIds.slice(i, i + SWEEP_CONCURRENCY).map((remId) =>
        reviewHeldRem(plugin, remId, minDays, force).catch((e) => {
          console.warn(`${LOG} could not review Rem ${remId}:`, e);
          return false;
        })
      )
    );
    released += results.filter(Boolean).length;
  }
  return released;
}

/** Background work at queue start: low concurrency, so it does not compete with GetNextCard's prefetch. */
function scheduleSweep(plugin: RNPlugin, enabled: boolean, minDays: number) {
  // Off means release now, whenever the last check ran.
  if (enabled && Date.now() - lastSweepAt < SWEEP_MIN_GAP_MS) return;
  lastSweepAt = Date.now();
  setTimeout(async () => {
    const ids = Object.keys(held) as RemId[];
    if (ids.length === 0) return;
    const chosen = enabled ? sampleOf(ids, SWEEP_SAMPLE) : ids;
    const released = await reviewMany(plugin, chosen, minDays, !enabled);
    console.log(`${LOG} checked ${chosen.length} of ${ids.length} held Rems, released ${released}`);
  }, SWEEP_DELAY_MS);
}

async function startSession(plugin: RNPlugin): Promise<void> {
  const path = await plugin.window.getURL();
  // RemNote fires QueueEnter twice as a queue opens.
  if (session?.path === path) return;
  session = null;
  held = await readHeld(plugin);
  const [enabled, minDays] = await Promise.all([
    getIESetting(plugin, recognitionFirstId),
    getIESetting(plugin, recognitionFirstMinDaysId),
  ]);
  scheduleSweep(plugin, enabled, minDays);
  if (!enabled) return;
  if (queueRouteKind(path) === 'other') return;
  session = { path, minDays, currentCardId: null, loadsByCard: new Map(), deletedForwardCards: new Set(), toastShown: false };
  console.log(`${LOG} active on ${path}; ${Object.keys(held).length} Rems held`);
}

export async function releaseAllRecognitionFirst(plugin: RNPlugin) {
  held = await readHeld(plugin);
  const ids = Object.keys(held) as RemId[];
  const released = await reviewMany(plugin, ids, 0, true);
  await plugin.app.toast(`Recognition First: released ${released} of ${ids.length} held concepts.`);
}

export function registerRecognitionFirst(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.QueueEnter, undefined, () => {
    entering = entering.then(() => startSession(plugin)).catch((e) => console.warn(`${LOG} QueueEnter failed:`, e));
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    await entering;
    const s = session;
    const cardId: string | undefined = data?.cardId;
    // RemNote fires an id-less load around every card change: acting on one takes the next card.
    if (!s || !cardId) return;
    s.currentCardId = cardId;
    const loads = (s.loadsByCard.get(cardId) ?? 0) + 1;
    s.loadsByCard.set(cardId, loads);
    if (loads > MAX_LOADS_PER_CARD) {
      console.warn(`${LOG} card ${cardId} loaded ${loads} times: left alone.`);
      return;
    }
    try {
      if (s.deletedForwardCards.has(cardId)) {
        if (await removeFromQueue(plugin, s, cardId)) console.log(`${LOG} skipped deleted front → back card ${cardId}, still in the queue's batch`);
        return;
      }
      await checkCard(plugin, s, cardId);
    } catch (e) {
      console.warn(`${LOG} check failed for ${cardId}:`, e);
    }
  });

  // Fires in every queue: a pass in Practice All counts too.
  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, (data: any) => {
    const cardId: string | undefined = data?.cardId;
    if (!cardId) return;
    if (session?.currentCardId === cardId) session.currentCardId = null;
    onRating(plugin, cardId, data?.score).catch((e) => console.warn(`${LOG} rating failed:`, e));
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    session = null;
  });

  // Going to another page keeps the queue's session but not its card.
  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    const s = session;
    if (s && (await plugin.window.getURL()) !== s.path) s.currentCardId = null;
  });

  void plugin.app.registerCommand({
    id: 'recognition-first-release-all',
    name: 'Recognition First: Release All Held Concepts',
    description: 'Sets every concept held by Recognition First back to practising both directions.',
    quickCode: 'rfr',
    action: () => releaseAllRecognitionFirst(plugin),
  });
}
