import { AppEvents, PluginRem, QueueInteractionScore, QueueItemType, RemId, RNPlugin } from '@remnote/plugin-sdk';
import { masteryDrillMinDelayMinutesId, masteryDrillRevealDelayId } from './consts';
import { getIESetting } from './settings';
import { FinalDrillEntry, finalDrillIdsKey } from './mastery_drill_status';
import { showMessageDialog } from './message_dialog';
import { NativeDrillState, nativeDrillStartRequestKey, nativeDrillStateKey } from './mastery_drill_launch';

/**
 * The Mastery Drill in RemNote's own queue ("Where the Drill Runs: Regular queue").
 *
 * WHY: the popup drill embeds the SDK <Queue>, which RemNote renders with
 * `inArticle: true` — and every flashcard widget location is switched off there,
 * ours and every other plugin's. In the regular queue they all show.
 *
 * HOW: a plugin cannot hand RemNote a list of card ids (the native filtered queue
 * reads its ids from the host's localStorage), so each session builds a fresh
 * document holding one reference per drill Rem and opens it in Practice All
 * (`/flashcards/<doc>/all`, which serves cards that are not due). RemNote then
 * offers every card of those Rems; the ones that are not ready drill cards are
 * skipped on QueueLoadCard.
 *
 * What the tests established (Sep 2026), each handled here:
 *   - An id-less QueueLoadCard fires around every card change. Acting on it removes
 *     the NEXT real card (and looped RemNote once). Ignored.
 *   - A skip is visible for its round trip: under 150 ms usually, 600 ms+ right
 *     after a rating. A CSS mask keeps every card hidden for the Reveal Delay, and
 *     our own post-rating writes are deferred (deferDuringNativeDrill) so the skip
 *     reaches the bridge first.
 *   - A skip counts as "seen" for RemNote's bury rule, so a drill card whose sibling
 *     was skipped can be buried; RemNote then shows "Time to Take a Break", whose
 *     Keep Practicing serves them (for this queue only). The drill presses it itself
 *     through queue.rateCurrentCard (see pressKeepPracticing).
 *   - Practice All remembers progress per document id and asks "Continue where you
 *     left off?". A new document per session never has progress.
 * Ratings go through the normal QueueCompleteCard handler, which already adds a card
 * to the drill on Again/Hard (restarting its cooling) and removes it on Good/Easy.
 */

const LOG = '[MasteryDrill:native]';
const docIdKey = (kbId: string) => `mastery-drill-native-doc_${kbId}`;
const DOC_TITLE = 'Mastery Drill';
const MASK_CSS_ID = 'mastery-drill-native-mask';
/** Our post-rating work waits this long during the drill so a skip is not queued behind it. */
const DEFER_MS = 1000;
/** A card loading more often than this means something is looping: skipping stops. */
const MAX_LOADS_PER_CARD = 6;
/** The drill document is deleted this long after the queue closes, off RemNote's teardown. */
const DOC_DELETE_DELAY_MS = 3000;
/**
 * RemNote's "Time to Take a Break" (buried cards) screen, restyled while the drill shows it.
 * The drill presses Keep Practicing itself (pressKeepPracticing); this restyle is the fallback
 * for when that fails, making the button the obvious choice and saying why. Hooks read from the bundle: the checkpoint root
 * carries `queue-message--daily-target-checkpoint`; Keep Practicing is its "stop learning"
 * button (`Queue Checkpoint Abort Button`, Escape), Go To Flashcard Home the "continue" one.
 * The note is a full-width item of the buttons' own flex row (`div.gap-4`), so it wraps to
 * the line right under them.
 */
const BURY_CSS_ID = 'mastery-drill-native-bury-screen';
const buryScreenCss = (hiddenDrillCards: number) => `
.queue-message--daily-target-checkpoint [data-test="Queue Checkpoint Abort Button"] {
  background: var(--rn-clr-background-accent, #3b82f6) !important;
  color: #fff !important;
  border-color: transparent !important;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.35);
}
.queue-message--daily-target-checkpoint [data-test="Queue Checkpoint Continue Button"] {
  background: transparent !important;
  color: var(--rn-clr-content-secondary) !important;
  border: 1px solid var(--rn-clr-border-primary) !important;
}
.queue-message--daily-target-checkpoint div.gap-4:has([data-test="Queue Checkpoint Abort Button"]) {
  flex-wrap: wrap !important;
}
.queue-message--daily-target-checkpoint div.gap-4:has([data-test="Queue Checkpoint Abort Button"])::after {
  content: "Mastery Drill: ${hiddenDrillCards > 0 ? `${hiddenDrillCards} drill card${hiddenDrillCards === 1 ? ' was' : 's were'}` : 'drill cards were'} hidden because the plugin skipped another card of the same Rem (skipped cards are never shown). Press Keep Practicing, or Esc, to drill them.";
  flex-basis: 100%;
  max-width: 34rem;
  margin: 12px auto 0;
  font-size: 18px;
  line-height: 1.45;
  font-weight: 500;
  color: var(--rn-clr-content-primary);
  text-align: center;
}`;

// Module state of the index realm. The GetNextCard callback reads it synchronously.
let drillDocId: RemId | null = null;
let drillKbId: string | null = null;
let build: BuildInfo | null = null;
let session: Session | null = null;

interface BuildInfo {
  readyCardIds: Set<string>;
  remIds: Set<RemId>;
  minDelayMinutes: number;
}

interface Session {
  docId: RemId;
  /** Cards the queue may still show. A rated card leaves (it left the drill or restarted cooling). */
  allowed: Set<string>;
  loadsByCard: Map<string, number>;
  shown: number;
  rated: number;
  skipMs: number[];
  buried: boolean;
  /** The buried-cards screen restyle is registered; dropped on the next card. */
  buryScreenStyled: boolean;
  /** Times the drill pressed Keep Practicing itself this session. */
  keepPracticingPresses: number;
  tripped: boolean;
}

/** True when `subQueueId` is the regular-queue drill's document. Synchronous. */
export function isNativeDrillQueue(subQueueId: string | undefined | null): boolean {
  return !!drillDocId && subQueueId === drillDocId;
}

/** True while the regular-queue drill is open. Synchronous. */
export const isNativeDrillActive = () => !!session;

/** Resolves after DEFER_MS while the regular-queue drill is open, at once otherwise. */
export const deferDuringNativeDrill = () =>
  session ? new Promise<void>((resolve) => setTimeout(resolve, DEFER_MS)) : Promise.resolve();

async function readReadyCards(plugin: RNPlugin, kbId: string, isPrimary: boolean) {
  const minDelayMinutes = Number(await getIESetting(plugin, masteryDrillMinDelayMinutesId)) || 0;
  const items = ((await plugin.storage.getSynced(finalDrillIdsKey)) as FinalDrillEntry[]) || [];
  const now = Date.now();
  const readyCardIds = new Set<string>();
  const remIds = new Set<RemId>();
  let cooling = 0;
  for (const item of items) {
    const inKb = typeof item === 'string' ? isPrimary : item.kbId === kbId;
    if (!inKb) continue;
    const addedAt = typeof item === 'string' ? undefined : item.addedAt;
    if (addedAt && now - addedAt < minDelayMinutes * 60_000) {
      cooling++;
      continue;
    }
    const cardId = typeof item === 'string' ? item : item.cardId;
    const card = await plugin.card.findOne(cardId);
    if (!card?.remId) continue;
    readyCardIds.add(cardId);
    remIds.add(card.remId);
  }
  return { readyCardIds, remIds, cooling, minDelayMinutes };
}

async function deleteStoredDoc(plugin: RNPlugin, kbId: string): Promise<void> {
  const storedId = await plugin.storage.getSynced<string>(docIdKey(kbId));
  if (!storedId) return;
  const doc = await plugin.rem.findOne(storedId);
  if (doc) await doc.remove();
  await plugin.storage.setSynced(docIdKey(kbId), undefined);
}

async function createDrillDoc(plugin: RNPlugin, kbId: string, remIds: Set<RemId>): Promise<PluginRem> {
  // Always a NEW document: Practice All keeps progress per document id.
  await deleteStoredDoc(plugin, kbId);
  const doc = await plugin.rem.createRem();
  if (!doc) throw new Error('Could not create the drill document.');
  await doc.setText([DOC_TITLE]);
  await doc.setIsDocument(true);
  await plugin.storage.setSynced(docIdKey(kbId), doc._id);
  for (const remId of remIds) {
    const entry = await plugin.rem.createRem();
    if (!entry) continue;
    await entry.setParent(doc);
    await entry.setText([{ i: 'q', _id: remId }]);
  }
  return doc;
}

/** Builds the session document and opens it in RemNote's queue. Index realm only. */
export async function startNativeDrill(plugin: RNPlugin): Promise<void> {
  try {
    const kb = await plugin.kb.getCurrentKnowledgeBaseData();
    const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
    const ready = await readReadyCards(plugin, kb._id, isPrimary);
    if (ready.readyCardIds.size === 0) {
      await showMessageDialog(plugin, {
        title: 'Mastery Drill',
        message: 'No drill card is ready yet.',
        detail: ready.cooling
          ? `${ready.cooling} card${ready.cooling === 1 ? ' is' : 's are'} still inside the minimum delay (${ready.minDelayMinutes} min).`
          : undefined,
        tone: 'info',
      });
      return;
    }
    await plugin.app.toast(`Starting the Mastery Drill: ${ready.readyCardIds.size} cards…`);
    const doc = await createDrillDoc(plugin, kb._id, ready.remIds);
    drillDocId = doc._id;
    drillKbId = kb._id;
    build = { readyCardIds: ready.readyCardIds, remIds: ready.remIds, minDelayMinutes: ready.minDelayMinutes };
    console.log(`${LOG} ${ready.readyCardIds.size} ready cards on ${ready.remIds.size} Rems (${ready.cooling} cooling) in ${doc._id}`);
    await plugin.window.setURL(`/flashcards/${doc._id}/all`);
  } catch (e) {
    console.error(`${LOG} start failed:`, e);
    await showMessageDialog(plugin, { title: 'Mastery Drill could not start', message: String(e), tone: 'error' });
  }
}

const publishState = (plugin: RNPlugin, state: NativeDrillState) =>
  plugin.storage.setSession(nativeDrillStateKey, state);

function endSession(plugin: RNPlugin, reason: string) {
  const s = session;
  if (!s) return;
  session = null;
  void plugin.app.registerCSS(MASK_CSS_ID, '');
  void plugin.app.registerCSS(BURY_CSS_ID, '');
  void publishState(plugin, { active: false, buried: false });
  const sorted = [...s.skipMs].sort((a, b) => a - b);
  console.log(
    `${LOG} session ended (${reason}): ${s.shown} shown, ${s.rated} rated, ${s.skipMs.length} skipped ` +
      `(median ${sorted[Math.floor(sorted.length / 2)] ?? 0} ms, max ${sorted[sorted.length - 1] ?? 0} ms)` +
      (s.buried ? ', RemNote buried some drill cards' : '') +
      (s.tripped ? ', LOOP GUARD TRIPPED' : '')
  );

  // The document only exists for this session. Delete it once RemNote has finished closing
  // the queue — unless a new drill has replaced it meanwhile.
  const docId = drillDocId;
  const kbId = drillKbId;
  setTimeout(async () => {
    if (session || drillDocId !== docId || !kbId) return;
    try {
      await deleteStoredDoc(plugin, kbId);
      drillDocId = null;
      build = null;
    } catch (e) {
      console.warn(`${LOG} could not delete the drill document:`, e);
    }
  }, DOC_DELETE_DELAY_MS);
}

/**
 * Presses Keep Practicing on RemNote's buried-cards screen. `queue.rateCurrentCard` answers
 * a card, but on a checkpoint screen it calls the screen's handlers instead (read from the
 * bundle): Good/Easy → onContinueLearning (Go To Flashcard Home), Again/Hard →
 * onStopLearning, which on this screen is Keep Practicing — it sets the bury provider's
 * practiceBuriedCards for this queue only, so the hidden cards are served.
 *
 * Rating Again with a real card on screen would record a lapse, so the screen type is read
 * again right before, and the press is attempted at most twice per session.
 */
async function pressKeepPracticing(plugin: RNPlugin, s: Session, hidden: number): Promise<boolean> {
  if (s.keepPracticingPresses >= 2) return false;
  s.keepPracticingPresses++;
  try {
    if ((await plugin.queue.getCurrentQueueScreenType()) !== QueueItemType.PracticeBuried || session !== s) return false;
    await plugin.queue.rateCurrentCard(QueueInteractionScore.AGAIN);
    console.log(`${LOG} pressed Keep Practicing on RemNote's buried-cards screen; ${hidden} drill cards not served yet.`);
    void plugin.app.toast(
      `Mastery Drill: RemNote had hidden ${hidden > 0 ? hidden : 'some'} drill card${hidden === 1 ? '' : 's'} ` +
        `(a related card was skipped). Continuing with ${hidden === 1 ? 'it' : 'them'}.`
    );
    return true;
  } catch (e) {
    console.warn(`${LOG} could not press Keep Practicing:`, e);
    return false;
  }
}

export function registerNativeDrillListeners(plugin: RNPlugin) {
  plugin.event.addListener(AppEvents.StorageSessionChange, nativeDrillStartRequestKey, () => {
    void startNativeDrill(plugin);
  });

  plugin.event.addListener(AppEvents.QueueEnter, undefined, async (data: any) => {
    if (!isNativeDrillQueue(data?.subQueueId) || !build) {
      if (session) endSession(plugin, 'another queue opened');
      return;
    }
    // RemNote fires QueueEnter twice as the queue opens; keep what the first one started.
    if (session?.docId === data.subQueueId) return;
    if (session) endSession(plugin, 'a new drill replaced it');
    session = {
      docId: data.subQueueId,
      allowed: new Set(build.readyCardIds),
      loadsByCard: new Map(),
      shown: 0,
      rated: 0,
      skipMs: [],
      buried: false,
      buryScreenStyled: false,
      keepPracticingPresses: 0,
      tripped: false,
    };
    // Registered from the index realm (this listener runs there): the only place registerCSS works.
    // The animation restarts for every card because RemNote mounts a new .rn-queue__content per card.
    // `backwards`, not `both`: a forwards fill keeps .rn-queue__content a stacking context
    // for as long as the card is up, which traps the docked card_info_bar under RemNote's
    // bottom mask (lib/card_info_bar_dock). The end value is the natural opacity anyway.
    const delay = Math.max(0, Number(await getIESetting(plugin, masteryDrillRevealDelayId)) || 0);
    void plugin.app.registerCSS(
      MASK_CSS_ID,
      delay
        ? `@keyframes ie-mastery-drill-reveal { from { opacity: 0; } to { opacity: 1; } }
.rn-queue__content { animation: ie-mastery-drill-reveal 120ms ease-out ${delay}ms backwards; }`
        : ''
    );
    void publishState(plugin, { active: true, buried: false });
    console.log(`${LOG} queue entered`);
  });

  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async (data: any) => {
    const s = session;
    if (!s) return;
    const receivedAt = Date.now();
    const cardId: string | undefined = data?.cardId;

    // RemNote fires an id-less load around every card change and moves past it by itself.
    // Removing on it would remove the NEXT real card. One of them is the bury screen.
    if (!cardId) {
      const screen = await plugin.queue.getCurrentQueueScreenType();
      if (screen === QueueItemType.PracticeBuried && session === s) {
        // Drill cards the queue has not served yet: the ones RemNote is holding back.
        const hidden = [...s.allowed].filter((id) => !s.loadsByCard.has(id)).length;
        if (await pressKeepPracticing(plugin, s, hidden)) return;
        s.buryScreenStyled = true;
        void plugin.app.registerCSS(BURY_CSS_ID, buryScreenCss(hidden));
        if (!s.buried) {
          s.buried = true;
          void publishState(plugin, { active: true, buried: true });
        }
        void plugin.app.toast(
          `Mastery Drill: RemNote hid ${hidden > 0 ? hidden : 'some'} drill card${hidden === 1 ? '' : 's'}. Press Keep Practicing (or Esc) to drill ${hidden === 1 ? 'it' : 'them'}.`
        );
        console.log(`${LOG} RemNote's buried-cards screen is up; ${hidden} drill cards not served yet.`);
      }
      return;
    }
    if (s.buryScreenStyled) {
      s.buryScreenStyled = false;
      void plugin.app.registerCSS(BURY_CSS_ID, '');
    }

    const loads = (s.loadsByCard.get(cardId) ?? 0) + 1;
    s.loadsByCard.set(cardId, loads);
    if (!s.tripped && loads > MAX_LOADS_PER_CARD) {
      s.tripped = true;
      console.warn(`${LOG} card ${cardId} loaded ${loads} times: skipping stopped for this session.`);
      void plugin.app.toast('Mastery Drill: the queue seems to be looping, so cards are no longer skipped.');
    }

    if (s.allowed.has(cardId)) {
      s.shown++;
      return;
    }
    if (s.tripped) return;
    // No getCurrentCard check first: it doubled the skip time. A misplaced removal would show
    // as a drill card vanishing unrated; the tests saw none once id-less loads were ignored.
    try {
      await plugin.queue.removeCurrentCardFromQueue(false);
    } catch (e) {
      console.error(`${LOG} skip failed for ${cardId}:`, e);
    }
    s.skipMs.push(Date.now() - receivedAt);
    console.log(
      `${LOG} skipped ${cardId} (${build?.readyCardIds.has(cardId) ? 'drill card already rated' : 'not a ready drill card'}) ` +
        `in ${Date.now() - receivedAt} ms`
    );
  });

  plugin.event.addListener(AppEvents.QueueCompleteCard, undefined, (data: any) => {
    const s = session;
    const cardId: string | undefined = data?.cardId;
    if (!s || !cardId || !build) return;
    s.rated++;
    // A rated card leaves the session: Good/Easy took it out of the drill, Again/Hard restarted
    // its cooling. With no minimum delay a card rated Again/Hard may come straight back.
    const score: QueueInteractionScore | undefined = data?.score;
    const restartsCooling = score === QueueInteractionScore.AGAIN || score === QueueInteractionScore.HARD;
    if (!(restartsCooling && build.minDelayMinutes <= 0)) s.allowed.delete(cardId);
  });

  // A card taken out of the drill elsewhere (the card list, another device) stops being served.
  plugin.event.addListener(AppEvents.StorageSyncedChange, finalDrillIdsKey, (value: any) => {
    const s = session;
    if (!s) return;
    const items = (Array.isArray(value) ? value : (value?.value as FinalDrillEntry[] | undefined)) ?? null;
    if (!items) return;
    const inList = new Set(items.map((item: FinalDrillEntry) => (typeof item === 'string' ? item : item.cardId)));
    for (const id of [...s.allowed]) if (!inList.has(id)) s.allowed.delete(id);
  });

  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    endSession(plugin, 'queue closed');
  });

  // A document left behind by a session that never closed (RemNote quit mid-drill).
  setTimeout(async () => {
    try {
      if (session) return;
      const url = await plugin.window.getURL();
      if (typeof url === 'string' && url.includes('/flashcards')) return;
      const kb = await plugin.kb.getCurrentKnowledgeBaseData();
      await deleteStoredDoc(plugin, kb._id);
    } catch (e) {
      console.warn(`${LOG} stale document cleanup failed:`, e);
    }
  }, 15_000);
}
