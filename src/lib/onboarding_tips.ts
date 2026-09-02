import { RNPlugin } from '@remnote/plugin-sdk';
import {
  onboardingTipsStateKey,
  onboardingTipsLocalMirrorKey,
  onboardingTipsSnoozeKey,
  onboardingTipsAnsweredSessionKey,
  onboardingTipsDrawnSessionKey,
  onboardingTipsLastShownKey,
} from './consts';

/**
 * The tip pile behind the Incremental RemNote sidebar hub.
 *
 * A tip is one small thing the plugin can do, phrased so it can be acted on
 * immediately. **One tip per session**: the panel draws a tip when it mounts,
 * and once it is answered the tip area is done until the next start — see
 * {@link tipAnsweredThisSession}, which is what actually holds that line across
 * the remounts of the sidebar slot. The user has three answers to each:
 *
 *  - **I Got It** — acknowledged, and never shown again. Persisted per knowledge
 *    base in synced storage *and* mirrored locally, so it survives reloads,
 *    follows the user across devices, and outlives a synced value that comes
 *    back empty. See {@link acknowledgeTip}.
 *  - **✕** — not now. The tip stays in the pile and can resurface later; the
 *    panel also goes quiet for {@link TIP_SNOOZE_MS}, so a reload inside that
 *    window does not immediately produce another tip.
 *  - **Learn More** — opens the docs section for the feature, when the tip names
 *    one. Not every tip has a page (some are habits, not features), hence the
 *    optional `docsPath`.
 *
 * A fourth button, **All Tips**, escapes the one-per-session pacing: it opens
 * the whole pile in a popup (widgets/onboarding_tips.tsx), answered ones first
 * with the date they were answered.
 */
/**
 * Which pile a tip belongs to. The order of this list is the order the piles are
 * drawn in — see {@link pickTip}. It is not decoration: a tip is drawn at random,
 * so without staging, adding a dozen utility tips would make it more likely than
 * not that a brand-new user's first tip is about cycling text case rather than
 * about Alt+X.
 */
export const TIP_CATEGORY_ORDER = ['basics', 'utilities'] as const;
export type TipCategory = (typeof TIP_CATEGORY_ORDER)[number];

export interface OnboardingTip {
  /**
   * Stable identity. NEVER reuse or renumber an id: acknowledgements are stored
   * by id, so a recycled id would silently arrive pre-dismissed for every
   * existing user. Retiring a tip means deleting the entry and burying the id.
   */
  id: string;
  /**
   * Which pile this belongs to. Everything in an earlier category is exhausted
   * before a later one is offered, so `basics` teaches the daily loop and
   * `utilities` waits until it has been learnt. New feature tips go at the END
   * of their category.
   */
  category: TipCategory;
  /** Three or four words. The sidebar column is ~130px at its narrowest. */
  title: string;
  /**
   * ONE line of prose — roughly 90 characters, hard ceiling 110. This renders in
   * a sidebar the user can drag down to about 130px wide, where 90 characters
   * already wrap to four lines. A tip is a hook, not an explanation: the
   * explanation is what `docsPath` is for.
   */
  body: string;
  /**
   * Docs target for "Learn More", relative to `IE_DOCS_BASE_URL` (e.g.
   * `'Getting-Started/#making-a-rem-incremental'`). Omit when the tip has no
   * single page behind it; the button is then not rendered.
   */
  docsPath?: string;
}

/** How long the tip panel stays quiet after a tip is closed with ✕. */
export const TIP_SNOOZE_MS = 2 * 60 * 60 * 1000;

/**
 * The starter pile: the handful of things a new user has to know before the
 * plugin stops looking like a queue with extra buttons. Ordered roughly by when
 * they become useful, though tips are drawn at random — order is documentation
 * for whoever edits this list, not a sequence the user experiences.
 */
export const ONBOARDING_TIPS: OnboardingTip[] = [
  {
    id: 'create-first-incremental-rem',
    category: 'basics',
    title: 'Your first Incremental Rem',
    body: 'Alt+X on any Rem, nothing selected, and it joins your queue. No flashcard needed.',
    docsPath: 'Getting-Started/#making-a-rem-incremental',
  },
  {
    id: 'extract-while-reading',
    category: 'basics',
    title: 'Extract, don’t re-read',
    body: 'Alt+X with text selected pulls that passage out on its own. The source shrinks each pass.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-extract-altx--altshiftx',
  },
  {
    id: 'cloze-an-extract',
    category: 'basics',
    title: 'Extract → flashcard',
    body: 'Alt+Z clozes the words that matter. Reading becomes remembering, in place.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-cloze-altz--altshiftz',
  },
  {
    id: 'set-a-priority',
    category: 'basics',
    title: 'Priority runs the queue',
    body: 'Alt+P sets it. It is the one knob that changes what your day looks like.',
    docsPath: 'Prioritization-&-Sorting/#setting-priorities',
  },
  {
    id: 'priority-inheritance',
    category: 'basics',
    title: 'Set priority once',
    body: 'Priority is inherited — prioritise a document, override only the exceptions.',
    docsPath: 'Prioritization-&-Sorting/#priority-inheritance-system',
  },
  {
    id: 'sorting-criteria',
    category: 'basics',
    title: 'Tune your queue mix',
    body: 'Cards vs. reading vs. randomness, saved as presets. Click Sorting above.',
    docsPath: 'Prioritization-&-Sorting/#sorting-criteria',
  },
  {
    id: 'answer-buttons',
    category: 'basics',
    title: 'More than “next”',
    body: 'Reschedule, dismiss, reprioritise or open in the editor — without leaving the queue.',
    docsPath: 'Reviewing-Items-in-the-Queue/#the-answer-buttons',
  },
  {
    id: 'review-in-editor',
    category: 'basics',
    title: 'Review outside the queue',
    body: 'Long reading needs room. Ctrl+Shift+J opens the item in the editor and times it.',
    docsPath: 'Reviewing-Items-in-the-Editor/',
  },
  {
    id: 'priority-review-document',
    category: 'basics',
    title: 'Too many cards due?',
    body: 'A Priority Review Document collects the top items into one doc you can actually finish.',
    docsPath: 'Priority-Review-Document/',
  },
  {
    id: 'pdf-workflow',
    category: 'basics',
    title: 'Read PDFs incrementally',
    body: 'The plugin keeps your page, and turns highlights into prioritised extracts.',
    docsPath: 'PDF-Incremental-Reading-Workflow/',
  },
  {
    id: 'incremental-adoption',
    category: 'basics',
    title: 'Adopt it incrementally',
    body: 'Start with Incremental Rems and priority. Add the rest when the habit gets boring.',
    docsPath: 'What-is-Incrementalism%3F/',
  },
  {
    id: 'increm-list',
    category: 'basics',
    title: 'See the whole queue',
    body: 'The IncRem List shows priorities, due dates and history — and edits them inline.',
    docsPath: 'IncRem-List-and-Main-View/',
  },
  {
    id: 'keyboard-shortcuts',
    category: 'basics',
    title: 'One keystroke away',
    body: 'Alt+X, Alt+Shift+X and Alt+P cover the daily loop. Click to see the rest.',
    docsPath: 'Keyboard-Shortcuts/',
  },
  {
    id: 'study-dashboard',
    category: 'basics',
    title: 'Where did the time go?',
    body: 'The Study Dashboard breaks your reviews down by document and period.',
    docsPath: 'Study-Dashboard/',
  },
  {
    id: 'settings-live-here',
    category: 'basics',
    title: 'Settings, all in one place',
    body: 'The ⚙ above opens them: grouped, and each one linked to the page explaining it.',
    docsPath: 'Plugin-Settings-Reference/',
  },
  {
    id: 'review-queue-in-sidebar',
    category: 'basics',
    title: 'Your queue, on your phone',
    body: 'Priority Review Queue is pinned to your sidebar — where the plugin panel does not reach.',
    docsPath: 'Priority-Review-Document/#the-priority-review-queue-in-your-sidebar',
  },

  // --- Utilities -------------------------------------------------------
  // Drawn only once every `basics` tip has been acknowledged.
  {
    id: 'filter-images',
    category: 'utilities',
    title: 'Find every figure',
    body: 'Search cannot see images. Tag them once, then filter a document down to its figures.',
    docsPath: 'Utilities/#filter-a-document-by-images',
  },
  {
    id: 'pin-ring-indicators',
    category: 'utilities',
    title: 'Pins tell you more',
    body: 'Switch on pin rings: each pin then says where it goes — your figure, or the source.',
    docsPath: 'Colour-Coding-Reference/#reference-pin-rings',
  },
  {
    id: 'open-source-floating',
    category: 'utilities',
    title: 'Peek at the source',
    body: 'Hover a pin, press Opt+Shift+O: the PDF opens beside your card, queue still running.',
    docsPath: 'Utilities/#floating-window-interaction-closing',
  },
  {
    id: 'find-rem-picker',
    category: 'utilities',
    title: 'When [[ fails you',
    body: 'Opt+Shift+F finds Rems that RemNote’s own reference search buries, and links them.',
    docsPath: 'Utilities/#find-rem-reference-or-open',
  },
  {
    id: 'text-case-converter',
    category: 'utilities',
    title: 'Fix SHOUTING headings',
    body: 'Shift+F3 cycles the selection: Title Case, UPPERCASE, lowercase. Formatting survives.',
    docsPath: 'Utilities/#text-case-converter',
  },
  {
    id: 'set-next-heading-level',
    category: 'utilities',
    title: 'Headings without picking',
    body: 'Run “hn” and the Rem takes the level below its parent. Structure stays consistent.',
    docsPath: 'Utilities/#set-next-heading-level',
  },
  {
    id: 'inlinize-break-lists',
    category: 'utilities',
    title: 'Rescue a flattened list',
    body: 'A highlight that ate its line breaks: “inl” rebuilds the items, “brl” splits them out.',
    docsPath: 'Utilities/#inlinize-break-lists-from-pdf-highlights',
  },
    {
    id: 'queue-display-utilities',
    category: 'utilities',
    title: 'Queue Display Utilities',
    body: 'When hierarchy shown on cards become an issue, these utilities help manage the display.',
    docsPath: 'Utilities/#queue-display-utilities',
  },
  {
    id: 'hide-in-queue',
    category: 'utilities',
    title: 'Hide in Queue',
    body: 'Hide a spoiler parent and its text is masked on the front of its descendant cards.',
    docsPath: 'Utilities/#hide-in-queue',
  },
  {
    id: 'remove-from-queue',
    category: 'utilities',
    title: 'Remove from Queue',
    body: '“rfq” drops a parent from card display entirely, pulling its children up a level.',
    docsPath: 'Utilities/#remove-from-queue-rfq',
  },
  {
    id: 'hide-vs-remove-queue',
    category: 'utilities',
    title: 'Hide x Remove from Queue',
    body: '“Hide in Queue” avoids spoilers, "Remove from Queue" removes the parent entirely.',
    docsPath: 'Utilities/#queue-display-utilities',
  },
  {
    id: 'no-hierarchy',
    category: 'utilities',
    title: 'No Hierarchy',
    body: 'Use to hide every ancestor on a card display, front and back, when context gives it away.',
    docsPath: 'Utilities/#no-hierarchy-nh',
  },
    {
    id: 'hide-and-remove-targets',
    category: 'utilities',
    title: 'Hide & Remove what matters',
    body: '“Hide in Queue”/"Remove from Queue" can target the rem, its parent or grandparent.',
    docsPath: 'Utilities/#queue-display-utilities',
  },
  {
    id: 'hide-parent',
    category: 'utilities',
    title: 'Hide just the parent',
    body: '“hp” masks the immediate parent on the front, then reveals it on the back.',
    docsPath: 'Utilities/#hide-parent-hp',
  },
  {
    id: 'remove-parent',
    category: 'utilities',
    title: 'Drop the parent entirely',
    body: '“rp” removes the parent from both sides of the card. Alt+Z gets it automatically.',
    docsPath: 'Utilities/#remove-parent-rp-new',
  },
];

/**
 * Acknowledgement state for one knowledge base.
 *
 * Two shapes, because the first one had no clock in it. `acknowledgedAt` is what
 * is written now; `acknowledged` is the original id-only array, still read so
 * that nobody's answered tips come back, and never written again. A tip
 * recovered from the legacy array has no date — the list shows it as such rather
 * than inventing one.
 */
interface TipsState {
  /** LEGACY, read-only: ids with no acknowledgement date. */
  acknowledged?: string[];
  /** Tip id → epoch ms at which "I Got It" was pressed. */
  acknowledgedAt?: Record<string, number>;
}

/**
 * Synced storage is shared across every knowledge base the user owns, so the
 * state is partitioned by KB id — the same shape as the shield history. A tip
 * dismissed while learning anatomy should not be silently pre-dismissed in a
 * knowledge base started next year.
 */
type TipsStateByKb = Record<string, TipsState>;

/** Tip id → when it was acknowledged, or `null` when only the legacy array knew. */
export type AcknowledgedTipMap = Record<string, number | null>;

/**
 * The bucket written when the current knowledge base cannot be identified.
 *
 * `getCurrentKnowledgeBaseData()` is an IPC round trip that can come back empty
 * — most plausibly while the sidebar mounts during startup, which is exactly
 * when this panel reads. An acknowledgement made in that window used to land in
 * this bucket and stay there, invisible to every later read once the real id
 * resolved: the tip came back. Reads now fold this bucket into the current KB
 * and the next write clears it out.
 *
 * The fold is a guess, and knowingly so: the bucket exists precisely because the
 * knowledge base was unknown, so it is adopted by whichever KB reads it first.
 * With several knowledge bases that can pre-dismiss a tip in the wrong one. That
 * is the cheaper error — a tip not shown costs a hint, a tip shown again after
 * being retired reads as the plugin ignoring the user.
 */
const FALLBACK_KB_ID = 'default';

async function getKbId(plugin: RNPlugin): Promise<string> {
  try {
    const kb = await plugin.kb.getCurrentKnowledgeBaseData();
    return kb?._id ?? FALLBACK_KB_ID;
  } catch {
    return FALLBACK_KB_ID;
  }
}

async function readStore(
  plugin: RNPlugin,
  scope: 'synced' | 'local'
): Promise<TipsStateByKb> {
  try {
    const raw =
      scope === 'synced'
        ? await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)
        : await plugin.storage.getLocal<TipsStateByKb>(onboardingTipsLocalMirrorKey);
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Fold one KB's state into an accumulator, keeping the EARLIEST date known for
 *  an id: the mirror and the synced copy can disagree by a few milliseconds, and
 *  the honest answer is when the user actually pressed the button. */
function foldState(into: AcknowledgedTipMap, state: TipsState | undefined): void {
  if (!state) return;
  for (const id of state.acknowledged ?? []) {
    if (!(id in into)) into[id] = null;
  }
  for (const [id, at] of Object.entries(state.acknowledgedAt ?? {})) {
    if (typeof at !== 'number') continue;
    const prev = into[id];
    into[id] = typeof prev === 'number' ? Math.min(prev, at) : at;
  }
}

/**
 * Everything this device knows about what has been acknowledged in this KB:
 * the synced record, the local mirror and the fallback bucket, unioned.
 *
 * A union rather than a pick, because each source can be the only one holding a
 * given id — the mirror survives a synced wipe, the synced copy carries what
 * another device answered, and the fallback bucket holds whatever was answered
 * before the KB id resolved. Nothing here can subtract an acknowledgement, which
 * is the property that keeps a retired tip retired.
 */
async function collectForCurrentKb(plugin: RNPlugin): Promise<{
  kbId: string;
  map: AcknowledgedTipMap;
  synced: TipsStateByKb;
  local: TipsStateByKb;
}> {
  const [kbId, synced, local] = await Promise.all([
    getKbId(plugin),
    readStore(plugin, 'synced'),
    readStore(plugin, 'local'),
  ]);
  const map: AcknowledgedTipMap = {};
  foldState(map, synced[kbId]);
  foldState(map, local[kbId]);
  if (kbId !== FALLBACK_KB_ID) {
    foldState(map, synced[FALLBACK_KB_ID]);
    foldState(map, local[FALLBACK_KB_ID]);
  }
  return { kbId, map, synced, local };
}

/** Tip id → acknowledgement date (`null` if it predates the timestamps). */
export async function getAcknowledgedTipMap(plugin: RNPlugin): Promise<AcknowledgedTipMap> {
  return (await collectForCurrentKb(plugin)).map;
}

export async function getAcknowledgedTipIds(plugin: RNPlugin): Promise<string[]> {
  return Object.keys(await getAcknowledgedTipMap(plugin));
}

/**
 * Record "I Got It", to both stores.
 *
 * The write is a merge of everything already known, not an append to whichever
 * copy answered first: if synced storage returns empty because it has not
 * hydrated, appending to *that* would write a one-entry record over a full one
 * and un-retire every other tip. Merging first makes the worst case a no-op.
 */
export async function acknowledgeTip(plugin: RNPlugin, tipId: string): Promise<void> {
  const { kbId, map, synced, local } = await collectForCurrentKb(plugin);
  if (!(tipId in map)) map[tipId] = Date.now();

  // Dates only. The legacy array is folded into `map` above, so dropping it here
  // loses nothing — and an id with no date keeps `null`, which cannot be stored
  // in `acknowledgedAt`, so it is written back as the array it came from.
  const acknowledgedAt: Record<string, number> = {};
  const undated: string[] = [];
  for (const [id, at] of Object.entries(map)) {
    if (typeof at === 'number') acknowledgedAt[id] = at;
    else undated.push(id);
  }
  const next: TipsState = undated.length
    ? { acknowledgedAt, acknowledged: undated }
    : { acknowledgedAt };

  synced[kbId] = next;
  local[kbId] = next;
  // The fallback bucket has been folded in; leaving it would keep re-seeding
  // every read with a copy that no longer gains entries.
  if (kbId !== FALLBACK_KB_ID) {
    delete synced[FALLBACK_KB_ID];
    delete local[FALLBACK_KB_ID];
  }

  await plugin.storage.setSynced(onboardingTipsStateKey, synced);
  await plugin.storage.setLocal(onboardingTipsLocalMirrorKey, local);
}

/** Used by the "start over" affordance, and by anyone debugging the pile. */
export async function resetAcknowledgedTips(plugin: RNPlugin): Promise<void> {
  const { kbId, synced, local } = await collectForCurrentKb(plugin);
  for (const store of [synced, local]) {
    delete store[kbId];
    delete store[FALLBACK_KB_ID];
  }
  await plugin.storage.setSynced(onboardingTipsStateKey, synced);
  await plugin.storage.setLocal(onboardingTipsLocalMirrorKey, local);
  await plugin.storage.setLocal(onboardingTipsSnoozeKey, 0);
  // Otherwise "start over" hands back an empty pile and a panel that has
  // already used up its one tip for the session.
  await plugin.storage.setSession(onboardingTipsAnsweredSessionKey, false);
  await plugin.storage.setSession(onboardingTipsDrawnSessionKey, '');
  const lastShown =
    (await plugin.storage.getLocal<Record<string, Record<string, number>>>(
      onboardingTipsLastShownKey
    )) || {};
  delete lastShown[kbId];
  await plugin.storage.setLocal(onboardingTipsLastShownKey, lastShown);
}

/**
 * Snooze lives in *local* storage, not synced: "not right now" is about the
 * session in front of you, and syncing it would silence the panel on a device
 * the user has not touched yet.
 */
export async function snoozeTips(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setLocal(onboardingTipsSnoozeKey, Date.now() + TIP_SNOOZE_MS);
}

export async function tipsAreSnoozed(plugin: RNPlugin): Promise<boolean> {
  const until = (await plugin.storage.getLocal<number>(onboardingTipsSnoozeKey)) ?? 0;
  return Date.now() < until;
}

/**
 * Has a tip already been answered in this session?
 *
 * The panel promises one tip per session, and until this existed that promise
 * rested on the component staying mounted: RemNote remounts the `SidebarEnd`
 * slot as the app is used, and every remount re-ran the draw. That is invisible
 * while the pile is large — a fresh tip each time looks like a fresh tip — and
 * becomes obvious once a category is nearly exhausted, when the same two or
 * three survivors come round again and again and read as tips that were already
 * answered.
 *
 * Session storage, not local: the next start should offer a tip again. It is a
 * separate key from the snooze because the two mean different things — ✕ asks
 * for quiet across the next couple of hours *and* the next few starts, while
 * this only closes the current session.
 */
export async function tipAnsweredThisSession(plugin: RNPlugin): Promise<boolean> {
  return (await plugin.storage.getSession<boolean>(onboardingTipsAnsweredSessionKey)) ?? false;
}

export async function markTipAnsweredThisSession(plugin: RNPlugin): Promise<void> {
  await plugin.storage.setSession(onboardingTipsAnsweredSessionKey, true);
}

/** The tip already drawn in this session, if the panel has mounted before. */
export async function getDrawnTipIdThisSession(plugin: RNPlugin): Promise<string | null> {
  return (await plugin.storage.getSession<string>(onboardingTipsDrawnSessionKey)) ?? null;
}

export async function setDrawnTipIdThisSession(plugin: RNPlugin, tipId: string): Promise<void> {
  await plugin.storage.setSession(onboardingTipsDrawnSessionKey, tipId);
}

/** Tip id → when it was last put on screen, for this knowledge base. */
export async function getLastShownMap(plugin: RNPlugin): Promise<Record<string, number>> {
  try {
    const byKb =
      (await plugin.storage.getLocal<Record<string, Record<string, number>>>(
        onboardingTipsLastShownKey
      )) || {};
    return byKb[await getKbId(plugin)] ?? {};
  } catch {
    return {};
  }
}

/**
 * Stamp a tip as shown. Called only on a fresh draw — a remount that re-shows
 * the session's existing tip must not re-stamp it, or a tip could be pushed to
 * the back of the rotation without the user ever having answered it.
 */
export async function recordTipShown(plugin: RNPlugin, tipId: string): Promise<void> {
  try {
    const kbId = await getKbId(plugin);
    const byKb =
      (await plugin.storage.getLocal<Record<string, Record<string, number>>>(
        onboardingTipsLastShownKey
      )) || {};
    byKb[kbId] = { ...(byKb[kbId] ?? {}), [tipId]: Date.now() };
    await plugin.storage.setLocal(onboardingTipsLastShownKey, byKb);
  } catch {
    // Pacing only. A failure here costs a repeat, not a correctness problem.
  }
}

/**
 * Copy the synced record into the local mirror when the mirror is missing ids.
 *
 * The mirror only starts filling from the first acknowledgement made after it
 * was introduced, which leaves everything answered before then protected by
 * synced storage alone — the arrangement that lost the shield history when
 * RemNote reworked its storage layer. This closes that window on the next panel
 * mount instead of waiting for the user to answer another tip.
 *
 * One-directional and additive: it only ever writes local, and only ids the
 * union already contains, so it cannot resurrect a tip or clobber a mirror that
 * is ahead of the synced copy.
 */
export async function backfillLocalMirror(plugin: RNPlugin): Promise<void> {
  const { kbId, map, local } = await collectForCurrentKb(plugin);
  const mirrored = new Set([
    ...(local[kbId]?.acknowledged ?? []),
    ...Object.keys(local[kbId]?.acknowledgedAt ?? {}),
  ]);
  if (Object.keys(map).every((id) => mirrored.has(id))) return;

  const acknowledgedAt: Record<string, number> = {};
  const undated: string[] = [];
  for (const [id, at] of Object.entries(map)) {
    if (typeof at === 'number') acknowledgedAt[id] = at;
    else undated.push(id);
  }
  local[kbId] = undated.length ? { acknowledgedAt, acknowledged: undated } : { acknowledgedAt };
  await plugin.storage.setLocal(onboardingTipsLocalMirrorKey, local);
}

/** One row of {@link readTipsDiagnostics}: what each store says about one id. */
export interface TipsDiagnosticRow {
  id: string;
  /** Whether the id is still in {@link ONBOARDING_TIPS} — a stale id is dead weight. */
  known: boolean;
  inSynced: boolean;
  inLocal: boolean;
  /** True when the id was only found in the unidentified-KB fallback bucket. */
  fromFallbackOnly: boolean;
  at: number | null;
}

export interface TipsDiagnostics {
  kbId: string;
  /** False when `getCurrentKnowledgeBaseData()` came back empty — see FALLBACK_KB_ID. */
  kbResolved: boolean;
  /** Every partition in each store, with how many ids it holds. Shows at a
   *  glance whether acknowledgements are piling up under the wrong key. */
  syncedPartitions: { kbId: string; count: number; isCurrent: boolean }[];
  localPartitions: { kbId: string; count: number; isCurrent: boolean }[];
  rows: TipsDiagnosticRow[];
  /** Ids in ONBOARDING_TIPS that have not been acknowledged. */
  remaining: number;
  snoozedUntil: number;
  /** Session state: the tip drawn, and whether one has been answered already. */
  drawnThisSession: string | null;
  answeredThisSession: boolean;
  /**
   * The draw pool as the rotation sees it — every unacknowledged tip in the
   * category currently being offered, oldest first. The tip at the top is the
   * one the next session gets, which is the question this answers.
   */
  rotation: { id: string; category: TipCategory; lastShown: number | null }[];
  /** Raw values, for copying into a bug report. */
  raw: { synced: unknown; local: unknown };
}

/**
 * Read every store without touching any of them.
 *
 * The question this answers is "why did an answered tip come back?", and the
 * three ways that can happen are all visible here: the id is in one store and
 * not the other (a synced wipe, or a mirror written on another device), the id
 * sits under a KB partition that is not the current one (the fallback-bucket
 * bug), or the id is not there at all (the write never happened).
 */
export async function readTipsDiagnostics(plugin: RNPlugin): Promise<TipsDiagnostics> {
  const { kbId, map, synced, local } = await collectForCurrentKb(plugin);

  const idsOf = (state: TipsState | undefined): Set<string> =>
    new Set([
      ...(state?.acknowledged ?? []),
      ...Object.keys(state?.acknowledgedAt ?? {}),
    ]);
  const partitions = (store: TipsStateByKb) =>
    Object.keys(store).map((k) => ({
      kbId: k,
      count: idsOf(store[k]).size,
      isCurrent: k === kbId,
    }));

  const syncedCurrent = idsOf(synced[kbId]);
  const localCurrent = idsOf(local[kbId]);
  const known = new Set(ONBOARDING_TIPS.map((t) => t.id));

  const rows: TipsDiagnosticRow[] = Object.entries(map)
    .map(([id, at]) => ({
      id,
      known: known.has(id),
      inSynced: syncedCurrent.has(id),
      inLocal: localCurrent.has(id),
      fromFallbackOnly: !syncedCurrent.has(id) && !localCurrent.has(id),
      at,
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // Only the category actually being offered: a utilities tip cannot be drawn
  // while a basics tip is unanswered, so listing it would misreport what comes
  // next. Same staging rule as pickTip.
  const lastShown = await getLastShownMap(plugin);
  const activeCategory = TIP_CATEGORY_ORDER.find((c) =>
    ONBOARDING_TIPS.some((t) => t.category === c && !(t.id in map))
  );
  const rotation = ONBOARDING_TIPS.filter(
    (t) => t.category === activeCategory && !(t.id in map)
  )
    .map((t) => ({ id: t.id, category: t.category, lastShown: lastShown[t.id] ?? null }))
    .sort((a, b) => (a.lastShown ?? -Infinity) - (b.lastShown ?? -Infinity));

  return {
    kbId,
    kbResolved: kbId !== FALLBACK_KB_ID,
    syncedPartitions: partitions(synced),
    localPartitions: partitions(local),
    rows,
    remaining: ONBOARDING_TIPS.filter((t) => !(t.id in map)).length,
    snoozedUntil: (await plugin.storage.getLocal<number>(onboardingTipsSnoozeKey)) ?? 0,
    drawnThisSession: await getDrawnTipIdThisSession(plugin),
    answeredThisSession: await tipAnsweredThisSession(plugin),
    rotation,
    raw: { synced, local },
  };
}

/**
 * Draw one tip from what is left.
 *
 * Two rules, in order.
 *
 * **Categories are exhausted IN ORDER.** No `utilities` tip is offered while a
 * `basics` tip is still unacknowledged. Without that staging the pile is a flat
 * lottery, and adding the twelve utility tips would have made it more likely
 * than not that a new user's first tip was about cycling text case rather than
 * about Alt+X — the list order alone would not have prevented it, since nothing
 * consulted the order.
 *
 * **Within a category, least recently shown wins.** Never-shown tips come first
 * (random among them, so the pile is not walked in list order), and only once
 * they run out does the oldest previously-shown tip come round again. This is
 * what stops a tip repeating while others wait: a plain random draw has no
 * memory, so as a category empties out the survivors recur constantly — with
 * three tips left, the same one lands twice running about a third of the time,
 * which reads as the panel having forgotten it was already answered. Rotating
 * instead makes a repeat impossible until every other tip in the category has
 * had its turn.
 *
 * Ties are broken at random rather than by list order, so the rotation does not
 * harden into a fixed cycle the first time through.
 *
 * @param acknowledged Ids the user has answered "I Got It" to.
 * @param lastShown Tip id → when it was last on screen. Absent = never shown.
 */
export function pickTip(
  acknowledged: string[],
  lastShown: Record<string, number> = {}
): OnboardingTip | null {
  const answered = new Set(acknowledged);

  for (const category of TIP_CATEGORY_ORDER) {
    const pool = ONBOARDING_TIPS.filter((t) => t.category === category && !answered.has(t.id));
    if (pool.length === 0) continue;

    // `Infinity` is not a sentinel that needs special-casing anywhere below: a
    // never-shown tip is simply older than every shown one, which is exactly the
    // ordering wanted.
    const shownAt = (t: OnboardingTip) => lastShown[t.id] ?? -Infinity;
    const oldest = Math.min(...pool.map(shownAt));
    const candidates = pool.filter((t) => shownAt(t) === oldest);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return null;
}
