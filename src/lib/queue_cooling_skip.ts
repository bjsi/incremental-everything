import { AppEvents, PluginRem, RemId, RNPlugin } from '@remnote/plugin-sdk';
import { coolingInQueuesId, coolingNewCardsInQueuesId, currentScopeRemIdsKey } from './consts';
import { getIESetting } from './settings';
import { shouldUseLightMode } from './mobileUtils';
import { QueueRouteKind, queueRouteKind } from './queue_route';
import { coolingReasonText, CoolingVerdict, isCardDue, withSessionRatings } from './priority_review_document/cooling';
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
 * The "just created" rule stays with the Priority Queue by default: in a queue
 * it would skip every card written today. A setting (coolingNewCardsInQueuesId)
 * brings it to the spaced-repetition queues; never to Learn New, whose cards are
 * opened precisely to be learned.
 *
 * HOW: decided ahead, looked up on load — like the drill, whose live checks
 * were too slow for its mask.
 *   - One CoolingScanner per session, its card facts (card cache, or one
 *     card.getAll()) loaded once.
 *   - Ahead: when the plugin's own QueueEnter has written the queue's scope
 *     (currentScopeRemIdsKey), every Rem in it with a due card is judged in the
 *     background, cluster membership of the cooling ones included, up to
 *     MAX_JUDGED_AHEAD. The tree reads are memoised by the scanner.
 *   - On load: QueueLoadCard carries only the card id, so one read finds the
 *     Rem; the verdict is then a lookup. A Rem not judged ahead (the daily
 *     queue has no scope; a scan still running) is judged live, and flashes.
 *   - On a rating: it is laid over the Rem's facts (a plugin read would not see
 *     it yet, and cache facts carry no card ids), and every judged Rem is judged
 *     again from memory — no read — so the Rem and its relatives cool at once.
 *   - A card is judged with its own sightings left out (verdictForCard): having been seen
 *     cools its siblings, never the card itself when it comes back.
 *   - Every card counted as seen keeps a trace (how, how long it was current, id-less loads in
 *     between, whether a rating followed), printed with the skips it causes and at session end.
 * The same safeguards as the drill: id-less loads ignored, no removal once the
 * user has moved on, and a loop guard.
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
/** Rems with a due card beyond which the scope is not judged ahead (about 1.5 s per 200). */
const MAX_JUDGED_AHEAD = 500;
/** A card the queue left behind sooner than this can hardly have been read: flagged in the trace. */
const BRIEF_MS = 2000;
/** How long a card left behind waits for its rating (deferred by RemNote) before it is traced. */
const RATING_GRACE_MS = 3000;

type SessionKind = Exclude<QueueRouteKind, 'other'>;

/**
 * Why the session counts a card as seen — the trace behind a skip whose reason is a card seen in
 * this session. A card is "left behind" when another card loads after it (RemNote reports the
 * rating only after the next card has loaded), "rated" when QueueCompleteCard names it first.
 */
interface Sighting {
  at: number;
  how: 'left-behind' | 'rated';
  /** How long it was the current card before the queue moved on. */
  currentForMs?: number;
  /** The card whose load moved the queue past it. */
  nextCardId?: string;
  /** Id-less loads between its load and the next card's: IncRems, the break item, RemNote's own. */
  idlessLoads?: number;
  /** When the first of them fired, in ms after its load. */
  firstIdlessAfterMs?: number;
  /** The score QueueCompleteCard reported for it; absent when it was never rated. */
  score?: number;
}

interface Session {
  kind: SessionKind;
  path: string;
  /** The queue's document; the daily queue has none, and so no scope to judge ahead. */
  subQueueId: string | null;
  enteredAt: number;
  scanner: Promise<CoolingScanner | null>;
  scopeTaken: boolean;
  /** Re-judging after a rating: a load waits for it, it reads nothing. */
  pending: Promise<void>;
  /** The card on screen, cleared once it is rated. */
  currentCardId: string | null;
  /** When the current card's load arrived, and the id-less loads since — for the trace. */
  currentLoadedAt: number | null;
  idlessSinceLoad: number;
  firstIdlessAt: number | null;
  /** Card id → why it counts as seen. */
  sightings: Map<string, Sighting>;
  remByCard: Map<string, RemId>;
  /** Card id → when the session saw it rated. */
  ratedAt: Map<string, number>;
  skipped: Set<string>;
  loadsByCard: Map<string, number>;
  clusterByParent: Map<RemId, Promise<boolean>>;
  checkMs: number[];
  /** Loads answered from a verdict judged ahead, vs judged live. */
  judgedAhead: number;
  /** Skips whose removal landed after the mask revealed the card (the first card's longer hold aside). */
  lateSkips: number;
  /** True until the first card's check ends and the hold drops to MASK_DELAY_MS. */
  firstCardHold: boolean;
  tripped: boolean;
  toastShown: boolean;
  /** The new-card toast, shown once: a document written today skips every card for that reason. */
  newCardToastShown: boolean;
}

let session: Session | null = null;
/**
 * The queue scope the plugin's QueueEnter last wrote, and when — it may land before our session
 * opens. The host broadcasts every setSession with its value (StorageSessionChange), so the ids
 * arrive with the event and need no read back.
 */
let lastScope: { at: number; ids: RemId[] } | null = null;
/** The QueueEnter work in flight; a load waits for it so the first card is judged too. */
let entering: Promise<void> = Promise.resolve();

/** Resolves after DEFER_MS while a Learn New session is open, at once otherwise. */
export const deferDuringLearnNew = () =>
  session?.kind === 'learn-new'
    ? new Promise<void>((resolve) => setTimeout(resolve, DEFER_MS))
    : Promise.resolve();

async function openScanner(plugin: RNPlugin, kind: SessionKind): Promise<CoolingScanner | null> {
  try {
    const [params, cardSource, newCardsToo] = await Promise.all([
      getCoolingParams(plugin),
      loadCardSource(plugin),
      kind === 'spaced' ? getIESetting(plugin, coolingNewCardsInQueuesId) : false,
    ]);
    const scanner = new CoolingScanner(plugin, {
      // The "just created" rule only where the user asked for it: it skips every card written
      // today in the daily queue, and in Learn New the cards are opened precisely to be learned.
      params: newCardsToo === true ? params : { ...params, newCardDays: 0 },
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

async function startSession(plugin: RNPlugin, enteredAt: number, subQueueId: string | null): Promise<void> {
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

  const s: Session = {
    kind,
    path,
    subQueueId,
    enteredAt,
    scanner: openScanner(plugin, kind),
    scopeTaken: false,
    pending: Promise.resolve(),
    currentCardId: null,
    currentLoadedAt: null,
    idlessSinceLoad: 0,
    firstIdlessAt: null,
    sightings: new Map(),
    remByCard: new Map(),
    ratedAt: new Map(),
    skipped: new Set(),
    loadsByCard: new Map(),
    clusterByParent: new Map(),
    checkMs: [],
    judgedAhead: 0,
    lateSkips: 0,
    firstCardHold: kind === 'learn-new',
    tripped: false,
    toastShown: false,
    newCardToastShown: false,
  };
  session = s;
  if (kind === 'learn-new') setMask(plugin, FIRST_CARD_HOLD_MS);
  console.log(`${LOG} ${kind} session on ${path}`);
  if (subQueueId && lastScope && lastScope.at >= enteredAt) void takeScope(plugin, s, lastScope.ids);
}

/** Takes this queue's scope once the plugin's QueueEnter has written it, and judges it ahead. */
async function takeScope(plugin: RNPlugin, s: Session, ids: RemId[]): Promise<void> {
  if (s.scopeTaken || !s.subQueueId || session !== s || ids.length === 0) return;
  s.scopeTaken = true;
  try {
    await judgeAhead(plugin, s, ids);
  } catch (e) {
    console.warn(`${LOG} judging ahead failed; cards are judged as they load:`, e);
  }
}

async function judgeAhead(plugin: RNPlugin, s: Session, scopeIds: RemId[]): Promise<void> {
  const started = Date.now();
  const scanner = await s.scanner;
  if (!scanner) return;
  const now = Date.now();
  const candidates = scopeIds.filter((id) => scanner.cardsOf(id).some((c) => isCardDue(c, now)));
  if (candidates.length > MAX_JUDGED_AHEAD) {
    console.log(`${LOG} ${candidates.length} Rems with due cards in scope: too many to judge ahead, judged as they load.`);
    return;
  }
  await scanner.refresh(candidates);
  // Cluster membership of the cooling ones, so a load needs no read for that either.
  await Promise.all(
    candidates
      .filter((id) => scanner.verdicts.has(id))
      .map(async (id) => {
        const rem = await scanner.remOf(id);
        if (rem) await inCluster(plugin, s, rem);
      })
  );
  console.log(
    `${LOG} judged ${candidates.length} Rems ahead (${scopeIds.length} in scope) in ${Date.now() - started} ms: ` +
      `${candidates.filter((id) => scanner.verdicts.has(id)).length} cooling`
  );

  // Their card ids too, so a card that loads needs no read to find its Rem. Right after a
  // rating that read queues behind the traffic the rating starts (600–860 ms measured), which
  // is what outran the mask.
  const idsStarted = Date.now();
  let mapped = 0;
  for (let i = 0; i < candidates.length && session === s; i += 8) {
    await Promise.all(
      candidates.slice(i, i + 8).map(async (remId) => {
        try {
          const rem = await scanner.remOf(remId);
          for (const card of (await rem?.getCards()) || []) {
            s.remByCard.set(card._id, remId);
            mapped++;
          }
        } catch {
          /* that Rem's cards are found by a read when they load */
        }
      })
    );
  }
  console.log(`${LOG} mapped ${mapped} card ids to their Rems in ${Date.now() - idsStarted} ms`);
}

/**
 * Records a card as seen now — rated, or left behind — lays it over its Rem's facts and judges
 * every judged Rem again from memory, so the Rem and its relatives cool. Loads wait for it.
 */
function noteSeen(plugin: RNPlugin, s: Session, cardId: string, sighting: Omit<Sighting, 'at'>) {
  if (s.ratedAt.has(cardId)) return;
  const at = Date.now();
  s.ratedAt.set(cardId, at);
  s.sightings.set(cardId, { ...sighting, at });
  s.pending = s.pending
    .then(async () => {
      const scanner = await s.scanner;
      if (!scanner) return;
      let remId = s.remByCard.get(cardId);
      if (!remId) {
        remId = (await plugin.card.findOne(cardId))?.remId as RemId | undefined;
        if (!remId) return;
        s.remByCard.set(cardId, remId);
      }
      if (sighting.how === 'left-behind') {
        // The rating of a card left behind arrives after the next card's load: wait for it, and
        // trace only a card the queue passed without one, or too soon to have been read.
        const traced = remId;
        setTimeout(() => {
          const x = s.sightings.get(cardId);
          if (!x || (typeof x.score === 'number' && (x.currentForMs ?? Infinity) >= BRIEF_MS)) return;
          console.log(`${LOG} card ${cardId} (Rem ${traced}) counted as seen: ${describeSighting(x)}`);
        }, RATING_GRACE_MS);
      }
      await scanner.updateCards(remId, withSessionRatings(scanner.cardsOf(remId), ratingsOf(s, remId)));
      await scanner.refresh([...scanner.checkedIds]);
    })
    .catch((e) => console.warn(`${LOG} re-judging after a card was seen failed:`, e));
}

function describeSighting(x: Sighting): string {
  const parts: string[] = [];
  parts.push(
    x.how === 'left-behind'
      ? `left behind at ${new Date(x.at).toLocaleTimeString()} when card ${x.nextCardId} loaded`
      : `rated at ${new Date(x.at).toLocaleTimeString()}`
  );
  if (typeof x.currentForMs === 'number') {
    parts.push(`current for ${x.currentForMs} ms${x.currentForMs < BRIEF_MS ? ' (too brief to have been read)' : ''}`);
  }
  if (x.idlessLoads) {
    parts.push(`${x.idlessLoads} id-less load${x.idlessLoads === 1 ? '' : 's'} in between (first at +${x.firstIdlessAfterMs} ms)`);
  }
  if (x.how === 'left-behind') parts.push(typeof x.score === 'number' ? `rated afterwards (score ${x.score})` : 'no rating reported');
  return parts.join(', ');
}

/** The Rem's cards rated in this session, card id → when. */
function ratingsOf(s: Session, remId: RemId): Map<string, number> {
  const out = new Map<string, number>();
  for (const [cardId, at] of s.ratedAt) if (s.remByCard.get(cardId) === remId) out.set(cardId, at);
  return out;
}

/**
 * Every card mounts hidden and fades in after `delayMs`. Registered from the index realm
 * (these listeners run there): the only place registerCSS works. The animation restarts for
 * every card because RemNote mounts a new .rn-queue__content per card. The fill is
 * `backwards`, not `both`: a forwards fill keeps the content a stacking context and hides
 * the docked card_info_bar under RemNote's bottom mask (lib/card_info_bar_dock).
 */
function setMask(plugin: RNPlugin, delayMs: number) {
  void plugin.app.registerCSS(
    MASK_CSS_ID,
    `@keyframes ie-learn-new-reveal { from { opacity: 0; } to { opacity: 1; } }
.rn-queue__content { animation: ie-learn-new-reveal 120ms ease-out ${delayMs}ms backwards; }`
  );
}

function endSession(plugin: RNPlugin, reason: string) {
  const s = session;
  if (!s) return;
  session = null;
  if (s.kind === 'learn-new') void plugin.app.registerCSS(MASK_CSS_ID, '');
  const sorted = [...s.checkMs].sort((a, b) => a - b);
  console.log(
    `${LOG} ${s.kind} session ended (${reason}): ${s.checkMs.length} cards checked, ${s.judgedAhead} from verdicts judged ahead ` +
      `(median ${sorted[Math.floor(sorted.length / 2)] ?? 0} ms, max ${sorted[sorted.length - 1] ?? 0} ms), ` +
      `${s.skipped.size} skipped` +
      (s.kind === 'learn-new' ? `, ${s.lateSkips} removed after the ${MASK_DELAY_MS} ms mask (flashed)` : '') +
      (s.tripped ? ', LOOP GUARD TRIPPED' : '')
  );
  // Cards counted as seen that RemNote never reported rated: each one cooled its relatives on
  // the strength of having been on screen. The last card's rating may not have arrived yet.
  const unrated = [...s.sightings].filter(([, x]) => x.how === 'left-behind' && typeof x.score !== 'number');
  if (unrated.length) {
    console.log(
      `${LOG} ${unrated.length} card(s) counted as seen without a rating:\n` +
        unrated
          .slice(0, 30)
          .map(([cardId, x]) => `  ${cardId} (Rem ${s.remByCard.get(cardId) ?? '?'}): ${describeSighting(x)}`)
          .join('\n')
    );
  }
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
  if (reason?.relation === 'just-created') {
    if (s.newCardToastShown) return;
    s.newCardToastShown = true;
    void plugin.app.toast('Cooling: cards you just created are held back until their cooling ends.');
    return;
  }
  const why = reason
    ? coolingReasonText(reason.relation, ago(reason.seenAt))
    : 'its cooling was extended';
  void plugin.app.toast(`Cooling: skipped a card — ${why}.`);
}

async function checkCard(plugin: RNPlugin, s: Session, cardId: string): Promise<void> {
  const started = Date.now();
  const heldLonger = s.firstCardHold;
  const scanner = await s.scanner;
  if (!scanner) return;
  await s.pending;
  const waited = Date.now() - started;
  let remId = s.remByCard.get(cardId);
  const mappedAhead = !!remId;
  if (!remId) {
    // The one read a load needs: QueueLoadCard carries the card id only.
    remId = (await plugin.card.findOne(cardId))?.remId as RemId | undefined;
    if (!remId) return;
    s.remByCard.set(cardId, remId);
  }
  const ahead = scanner.checkedIds.has(remId);
  if (ahead) s.judgedAhead++;
  else await scanner.refresh([remId]);
  const now = Date.now();
  const remWide = scanner.verdicts.get(remId);
  // A card never spoils itself: its own sightings in this session hold only its siblings.
  const found = scanner.verdictForCard(remId, cardId, now);
  const verdict = found && found.until > now ? found : null;
  s.checkMs.push(Date.now() - started);
  if (!verdict) {
    if (remWide && remWide.until > now) {
      const own = s.sightings.get(cardId);
      console.log(
        `${LOG} "${remWide.label ?? remId}" (card ${cardId}) left in: only its own sighting held it` +
          (own ? ` — ${describeSighting(own)}` : '')
      );
    }
    return;
  }
  const decided = Date.now() - started;
  const rem = await scanner.remOf(remId);
  if (rem && (await inCluster(plugin, s, rem))) {
    console.log(`${LOG} "${verdict.label ?? remId}" is cooling but left in: a Card Cluster is shown as one unit.`);
    return;
  }
  // The user may have rated it or moved on meanwhile: a removal now would take the next card.
  if (session !== s || s.currentCardId !== cardId) {
    console.log(`${LOG} "${verdict.label ?? remId}" is cooling but left in: the queue moved on before the check ended (${Date.now() - started} ms).`);
    return;
  }
  s.skipped.add(cardId);
  const removing = Date.now();
  await plugin.queue.removeCurrentCardFromQueue(false);
  const timing =
    `waited ${waited} ms for re-judging, decided at ${decided} ms (Rem ${mappedAhead ? 'known' : 'read'}), ` +
    `removal took ${Date.now() - removing} ms`;
  if (s.kind === 'learn-new' && !heldLonger && Date.now() - started > MASK_DELAY_MS) s.lateSkips++;
  const reason = verdict.reasons[0];
  console.log(
    `${LOG} ${s.kind === 'learn-new' ? 'Learn New' : 'queue'}: skipped "${verdict.label ?? '(no text)'}" ` +
      `(card ${cardId}, Rem ${remId}) after ${Date.now() - started} ms, ${ahead ? 'judged ahead' : 'judged live'} [${timing}] — ` +
      (reason
        ? coolingReasonText(reason.relation, ago(reason.seenAt)) +
          (reason.sourceRemId !== remId ? ` ("${reason.sourceLabel ?? reason.sourceRemId}")` : '') +
          (reason.cardId ? ` (card ${reason.cardId})` : '')
        : 'its cooling was extended') +
      `; cooling until ${new Date(verdict.until).toLocaleString()}` +
      (verdict.reasons.length > 1 ? ` (${verdict.reasons.length} reasons)` : '') +
      `; loaded ${s.loadsByCard.get(cardId) ?? 1}× this session` +
      (reason?.cardId && s.sightings.has(reason.cardId)
        ? ` — that card was seen in this session: ${describeSighting(s.sightings.get(reason.cardId)!)}`
        : ''),
    verdict
  );
  announce(plugin, s, verdict);
}

export function registerQueueCoolingListeners(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.QueueEnter, undefined, (data: any) => {
    const enteredAt = Date.now();
    const subQueueId: string | null = data?.subQueueId ?? null;
    // Chained, so the second of RemNote's two QueueEnters sees the session the first opened.
    entering = entering
      .then(() => startSession(plugin, enteredAt, subQueueId))
      .catch((e) => console.warn(`${LOG} QueueEnter failed:`, e));
  });

  // The plugin's own QueueEnter writes the queue's scope once it has built it (a second or so).
  plugin.event.addListener(AppEvents.StorageSessionChange, currentScopeRemIdsKey, (value: any) => {
    const ids: unknown = Array.isArray(value) ? value : value?.value;
    if (!Array.isArray(ids)) return;
    lastScope = { at: Date.now(), ids: ids as RemId[] };
    const s = session;
    if (s && s.subQueueId && !s.scopeTaken) void takeScope(plugin, s, lastScope.ids);
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    const receivedAt = Date.now();
    await entering;
    const s = session;
    const cardId: string | undefined = data?.cardId;
    if (!s) return;
    // RemNote fires an id-less load around every card change and moves past it by itself.
    // Removing on it would remove the NEXT real card. An IncRem and the break item load
    // id-less too; they are only counted, for the trace of the card before them.
    if (!cardId) {
      s.idlessSinceLoad++;
      if (s.firstIdlessAt === null) s.firstIdlessAt = receivedAt;
      return;
    }
    // RemNote loads the next card BEFORE it reports the rating (QueueCompleteCard is emitted
    // deferred, after updateRepetitionStatus has advanced the queue). A card the queue has left
    // behind was on screen, so it counts as seen now — else the sibling loading next, the
    // "In Order" case, is judged without it. Cards this module removed were never shown.
    const previous = s.currentCardId;
    if (previous && previous !== cardId && !s.skipped.has(previous)) {
      const loadedAt = s.currentLoadedAt;
      noteSeen(plugin, s, previous, {
        how: 'left-behind',
        nextCardId: cardId,
        currentForMs: loadedAt === null ? undefined : receivedAt - loadedAt,
        idlessLoads: s.idlessSinceLoad,
        firstIdlessAfterMs: loadedAt === null || s.firstIdlessAt === null ? undefined : s.firstIdlessAt - loadedAt,
      });
    }
    if (previous !== cardId) {
      s.currentLoadedAt = receivedAt;
      s.idlessSinceLoad = 0;
      s.firstIdlessAt = null;
    }
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
    const receivedAt = Date.now();
    const s = session;
    const cardId: string | undefined = data?.cardId;
    if (!s || !cardId || s.skipped.has(cardId)) return;
    const score: number | undefined = typeof data?.score === 'number' ? data.score : undefined;
    const noted = s.sightings.get(cardId);
    if (noted) noted.score = score;
    const current = s.currentCardId === cardId;
    if (current) s.currentCardId = null;
    // Usually already noted when the next card loaded; a no-op then.
    noteSeen(plugin, s, cardId, {
      how: 'rated',
      score,
      currentForMs: current && s.currentLoadedAt !== null ? receivedAt - s.currentLoadedAt : undefined,
    });
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    endSession(plugin, 'queue closed');
  });
}
