import { AppEvents, PluginRem, RemId, RNPlugin } from '@remnote/plugin-sdk';
import { coolingInQueuesId } from './consts';
import { getIESetting } from './settings';
import { shouldUseLightMode } from './mobileUtils';
import { QueueRouteKind, queueRouteKind } from './queue_route';
import { COOLING_RELATION_LABELS, CoolingVerdict, withSessionRatings } from './priority_review_document/cooling';
import { CoolingScanner } from './priority_review_document/cooling_gather';
import { getCoolingParams } from './priority_review_document/cooling_store';
import { loadCardSource } from './priority_review_document/card_source';
import { hasCardClusterPowerup } from './priority_review_document/cluster';

/**
 * Cooling inside RemNote's own queues: a card whose Rem is cooling is skipped
 * with `removeCurrentCardFromQueue` as it loads.
 *
 * WHY: the Priority Queue keeps cooling Rems out of its document at refill, but
 * every other queue serves them — and within a session a card can start cooling
 * after the refill (its Alt+Z sibling was just graded). RemNote's own bury only
 * covers other cards of the same Rem, for an hour. In the Learn New queue it is
 * off altogether: that page opens the queue with `skipCheckpoints: true`, and
 * the bury provider reads the same flag as "practice buried cards", so the
 * clozes of one Rem run back to back (findings/QUEUE_AND_PRACTICE.md).
 *
 * WHERE (decided from the URL when the queue opens, see queue_route.ts):
 *   - Learn New: always, with a CSS mask that hides each card for a moment,
 *     because skips are frequent there (a batch is often one Rem's clozes).
 *     The mask is a fixed delay, like the drill's: a plugin cannot hide a card
 *     "until its check is done", since RemNote mounts the next card before a
 *     CSS change sent on QueueCompleteCard arrives, and nothing in the DOM tells
 *     two clozes of one Rem apart. The first card holds longer: its check also
 *     waits for the scanner to open (915 ms measured).
 *   - Spaced-repetition queues (a document, the daily queue, Priority Queue
 *     documents): behind a setting, and not in Light Mode, where the card facts
 *     would cost a full card read per session. A skipped card flashes; a toast
 *     says why.
 *   - Practice All, In Order, no-SRS, filtered queues and the regular-queue
 *     Mastery Drill (a Practice All route): never. Card Cluster members: never,
 *     as a cluster is shown as one unit.
 *
 * The "just created" rule stays with the Priority Queue: in a queue it would
 * skip every card written today.
 *
 * HOW: one CoolingScanner per session, its card facts loaded once. Each card
 * that loads is judged again with its Rem's cards read fresh. Ratings seen in
 * the session are laid over what the reads return, since a plugin read does not
 * wait for RemNote's pending writes. The same safeguards as the drill: id-less
 * loads ignored, no removal once the user has moved on, and a loop guard.
 */

const LOG = '[QueueCooling]';
const MASK_CSS_ID = 'learn-new-cooling-mask';
const MASK_DELAY_MS = 500;
/** The first card's hold: its check waits for the scanner to open as well. */
const FIRST_CARD_HOLD_MS = 2500;
/** Our post-rating work waits this long in Learn New so a skip is not queued behind it. */
const DEFER_MS = 1000;
/** A card loading more often than this means something is looping: skipping stops. */
const MAX_LOADS_PER_CARD = 6;

type SessionKind = Exclude<QueueRouteKind, 'other'>;

interface Session {
  kind: SessionKind;
  path: string;
  scanner: Promise<CoolingScanner | null>;
  /** The card on screen, cleared once it is rated. */
  currentCardId: string | null;
  remByCard: Map<string, RemId>;
  /** Card id → when the session saw it rated. */
  ratedAt: Map<string, number>;
  skipped: Set<string>;
  loadsByCard: Map<string, number>;
  clusterByParent: Map<RemId, Promise<boolean>>;
  checkMs: number[];
  /** True until the first card's check ends and the hold drops to MASK_DELAY_MS. */
  firstCardHold: boolean;
  tripped: boolean;
  toastShown: boolean;
}

let session: Session | null = null;
/** The QueueEnter work in flight; a load waits for it so the first card is judged too. */
let entering: Promise<void> = Promise.resolve();

/** Resolves after DEFER_MS while a Learn New session is open, at once otherwise. */
export const deferDuringLearnNew = () =>
  session?.kind === 'learn-new'
    ? new Promise<void>((resolve) => setTimeout(resolve, DEFER_MS))
    : Promise.resolve();

async function openScanner(plugin: RNPlugin): Promise<CoolingScanner | null> {
  try {
    const [params, cardSource] = await Promise.all([getCoolingParams(plugin), loadCardSource(plugin)]);
    const scanner = new CoolingScanner(plugin, {
      // Never the "just created" rule here: it would skip every card written today in the
      // daily queue, and in Learn New the cards are opened precisely to be learned.
      params: { ...params, newCardDays: 0 },
      cardSource,
      // Priorities only label verdicts; skip the second read of the card cache.
      priorityByRemId: new Map(),
    });
    await scanner.cardFacts(); // pays the one-off reads now, not on the first card
    return scanner;
  } catch (e) {
    console.warn(`${LOG} could not open the cooling scanner:`, e);
    return null;
  }
}

async function startSession(plugin: RNPlugin): Promise<void> {
  const path = await plugin.window.getURL();
  // RemNote fires QueueEnter twice as a queue opens; keep what the first one started.
  if (session && session.path === path) return;
  endSession(plugin, 'another queue opened');

  const kind = queueRouteKind(path);
  if (kind === 'other') return;
  if (kind === 'spaced') {
    if ((await getIESetting(plugin, coolingInQueuesId)) === false) return;
    if (await shouldUseLightMode(plugin)) return;
  }

  session = {
    kind,
    path,
    scanner: openScanner(plugin),
    currentCardId: null,
    remByCard: new Map(),
    ratedAt: new Map(),
    skipped: new Set(),
    loadsByCard: new Map(),
    clusterByParent: new Map(),
    checkMs: [],
    firstCardHold: kind === 'learn-new',
    tripped: false,
    toastShown: false,
  };
  if (kind === 'learn-new') setMask(plugin, FIRST_CARD_HOLD_MS);
  console.log(`${LOG} ${kind} session on ${path}`);
}

/**
 * Every card mounts hidden and fades in after `delayMs`. Registered from the index realm
 * (these listeners run there): the only place registerCSS works. The animation restarts for
 * every card because RemNote mounts a new .rn-queue__content per card.
 */
function setMask(plugin: RNPlugin, delayMs: number) {
  void plugin.app.registerCSS(
    MASK_CSS_ID,
    `@keyframes ie-learn-new-reveal { from { opacity: 0; } to { opacity: 1; } }
.rn-queue__content { animation: ie-learn-new-reveal 120ms ease-out ${delayMs}ms both; }`
  );
}

function endSession(plugin: RNPlugin, reason: string) {
  const s = session;
  if (!s) return;
  session = null;
  if (s.kind === 'learn-new') void plugin.app.registerCSS(MASK_CSS_ID, '');
  const sorted = [...s.checkMs].sort((a, b) => a - b);
  console.log(
    `${LOG} ${s.kind} session ended (${reason}): ${s.checkMs.length} cards checked ` +
      `(median ${sorted[Math.floor(sorted.length / 2)] ?? 0} ms, max ${sorted[sorted.length - 1] ?? 0} ms), ` +
      `${s.skipped.size} skipped` +
      (s.kind === 'learn-new'
        ? `, ${s.checkMs.slice(1).filter((ms) => ms > MASK_DELAY_MS).length} checks after the first outran the ${MASK_DELAY_MS} ms mask`
        : '') +
      (s.tripped ? ', LOOP GUARD TRIPPED' : '')
  );
}

/** A Card Cluster is shown as one unit: its members are never skipped one by one. */
function inCluster(plugin: RNPlugin, s: Session, rem: PluginRem): Promise<boolean> {
  const parentId = rem.parent as RemId | undefined;
  if (!parentId) return Promise.resolve(false);
  let pending = s.clusterByParent.get(parentId);
  if (!pending) {
    pending = plugin.rem
      .findOne(parentId)
      .then((parent) => (parent ? hasCardClusterPowerup(plugin, parent) : false))
      .catch(() => false);
    s.clusterByParent.set(parentId, pending);
  }
  return pending;
}

function ago(at: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function announce(plugin: RNPlugin, s: Session, verdict: CoolingVerdict) {
  if (s.kind === 'learn-new') {
    if (s.toastShown) return;
    s.toastShown = true;
    void plugin.app.toast('Cooling: cards whose sibling you just reviewed are held back for later.');
    return;
  }
  const reason = verdict.reasons[0];
  const why = reason
    ? `${COOLING_RELATION_LABELS[reason.relation]} ${ago(reason.seenAt)}`
    : 'its cooling was extended';
  void plugin.app.toast(`Cooling: skipped a card — ${why}.`);
}

async function checkCard(plugin: RNPlugin, s: Session, cardId: string): Promise<void> {
  const started = Date.now();
  const scanner = await s.scanner;
  if (!scanner) return;
  const card = await plugin.card.findOne(cardId);
  const remId = card?.remId as RemId | undefined;
  if (!remId) return;
  s.remByCard.set(cardId, remId);
  const rem = await plugin.rem.findOne(remId);
  if (!rem) return;
  const cards = withSessionRatings((await rem.getCards()) || [], s.ratedAt);
  const verdict = await scanner.rejudge(remId, cards);
  s.checkMs.push(Date.now() - started);
  if (!verdict) return;
  if (await inCluster(plugin, s, rem)) {
    console.log(`${LOG} "${verdict.label ?? remId}" is cooling but left in: a Card Cluster is shown as one unit.`);
    return;
  }
  // The user may have rated it or moved on meanwhile: a removal now would take the next card.
  if (session !== s || s.currentCardId !== cardId) {
    console.log(`${LOG} "${verdict.label ?? remId}" is cooling but left in: the queue moved on before the check ended (${Date.now() - started} ms).`);
    return;
  }
  s.skipped.add(cardId);
  await plugin.queue.removeCurrentCardFromQueue(false);
  const reason = verdict.reasons[0];
  console.log(
    `${LOG} ${s.kind === 'learn-new' ? 'Learn New' : 'queue'}: skipped "${verdict.label ?? '(no text)'}" ` +
      `(card ${cardId}, Rem ${remId}) after ${Date.now() - started} ms — ` +
      (reason
        ? `${COOLING_RELATION_LABELS[reason.relation]} ${ago(reason.seenAt)}` +
          (reason.sourceRemId !== remId ? ` ("${reason.sourceLabel ?? reason.sourceRemId}")` : '')
        : 'its cooling was extended') +
      `; cooling until ${new Date(verdict.until).toLocaleString()}` +
      (verdict.reasons.length > 1 ? ` (${verdict.reasons.length} reasons)` : ''),
    verdict
  );
  announce(plugin, s, verdict);
}

export function registerQueueCoolingListeners(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.QueueEnter, undefined, () => {
    // Chained, so the second of RemNote's two QueueEnters sees the session the first opened.
    entering = entering
      .then(() => startSession(plugin))
      .catch((e) => console.warn(`${LOG} QueueEnter failed:`, e));
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    await entering;
    const s = session;
    const cardId: string | undefined = data?.cardId;
    // RemNote fires an id-less load around every card change and moves past it by itself.
    // Removing on it would remove the NEXT real card.
    if (!s || !cardId) return;
    s.currentCardId = cardId;
    if (s.tripped) return;
    const loads = (s.loadsByCard.get(cardId) ?? 0) + 1;
    s.loadsByCard.set(cardId, loads);
    if (loads > MAX_LOADS_PER_CARD) {
      s.tripped = true;
      console.warn(`${LOG} card ${cardId} loaded ${loads} times: skipping stopped for this session.`);
      return;
    }
    try {
      await checkCard(plugin, s, cardId);
    } catch (e) {
      console.warn(`${LOG} check failed for ${cardId}:`, e);
    } finally {
      if (s.firstCardHold && session === s) {
        s.firstCardHold = false;
        setMask(plugin, MASK_DELAY_MS);
      }
    }
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, (data: any) => {
    const s = session;
    const cardId: string | undefined = data?.cardId;
    if (!s || !cardId || s.skipped.has(cardId)) return;
    s.ratedAt.set(cardId, Date.now());
    if (s.currentCardId === cardId) s.currentCardId = null;
    // The rating reaches the scanner's facts at once, so a sibling Rem loading next cools
    // even before RemNote has stored it.
    const remId = s.remByCard.get(cardId);
    if (!remId) return;
    void s.scanner.then(async (scanner) => {
      if (!scanner) return;
      const facts = await scanner.cardFacts();
      await scanner.updateCards(remId, withSessionRatings(facts.get(remId) ?? [], s.ratedAt));
    });
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    endSession(plugin, 'queue closed');
  });
}
