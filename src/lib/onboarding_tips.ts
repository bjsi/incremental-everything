import { RNPlugin } from '@remnote/plugin-sdk';
import { onboardingTipsStateKey, onboardingTipsSnoozeKey } from './consts';

/**
 * The tip pile behind the Incremental RemNote sidebar hub.
 *
 * A tip is one small thing the plugin can do, phrased so it can be acted on
 * immediately. **One tip per session**: the panel draws a tip when it mounts,
 * and once it is answered the tip area is done until the next start. The user
 * has three answers to each:
 *
 *  - **I Got It** — acknowledged, and never shown again. Persisted per knowledge
 *    base in synced storage, so it survives reloads and follows the user across
 *    devices.
 *  - **✕** — not now. The tip stays in the pile and can resurface later; the
 *    panel also goes quiet for {@link TIP_SNOOZE_MS}, so a reload inside that
 *    window does not immediately produce another tip.
 *  - **Learn More** — opens the docs section for the feature, when the tip names
 *    one. Not every tip has a page (some are habits, not features), hence the
 *    optional `docsPath`.
 */
export interface OnboardingTip {
  /**
   * Stable identity. NEVER reuse or renumber an id: acknowledgements are stored
   * by id, so a recycled id would silently arrive pre-dismissed for every
   * existing user. Retiring a tip means deleting the entry and burying the id.
   */
  id: string;
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
    title: 'Your first Incremental Rem',
    body: 'Alt+X on any Rem, nothing selected, and it joins your queue. No flashcard needed.',
    docsPath: 'Getting-Started/#method-2-keyboard-shortcut',
  },
  {
    id: 'extract-while-reading',
    title: 'Extract, don’t re-read',
    body: 'Alt+X with text selected pulls that passage out on its own. The source shrinks each pass.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-extract-altx--altshiftx',
  },
  {
    id: 'cloze-an-extract',
    title: 'Extract → flashcard',
    body: 'Alt+Z clozes the words that matter. Reading becomes remembering, in place.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-cloze-altz--altshiftz',
  },
  {
    id: 'set-a-priority',
    title: 'Priority runs the queue',
    body: 'Alt+P sets it. It is the one knob that changes what your day looks like.',
    docsPath: 'Prioritization-&-Sorting/#setting-priorities',
  },
  {
    id: 'priority-inheritance',
    title: 'Set priority once',
    body: 'Priority is inherited — prioritise a document, override only the exceptions.',
    docsPath: 'Prioritization-&-Sorting/#priority-inheritance-system',
  },
  {
    id: 'sorting-criteria',
    title: 'Tune your queue mix',
    body: 'Cards vs. reading vs. randomness, saved as presets. Click Sorting above.',
    docsPath: 'Prioritization-&-Sorting/#sorting-criteria',
  },
  {
    id: 'answer-buttons',
    title: 'More than “next”',
    body: 'Reschedule, dismiss, reprioritise or open in the editor — without leaving the queue.',
    docsPath: 'Reviewing-Items-in-the-Queue/#the-answer-buttons',
  },
  {
    id: 'review-in-editor',
    title: 'Review outside the queue',
    body: 'Long reading needs room. Ctrl+Shift+J opens the item in the editor and times it.',
    docsPath: 'Reviewing-Items-in-the-Editor/',
  },
  {
    id: 'priority-review-document',
    title: 'Too many cards due?',
    body: 'A Priority Review Document collects the top items into one doc you can actually finish.',
    docsPath: 'Priority-Review-Document/',
  },
  {
    id: 'pdf-workflow',
    title: 'Read PDFs incrementally',
    body: 'The plugin keeps your page, and turns highlights into prioritised extracts.',
    docsPath: 'PDF-Incremental-Reading-Workflow/',
  },
  {
    id: 'incremental-adoption',
    title: 'Adopt it incrementally',
    body: 'Start with Incremental Rems and priority. Add the rest when the habit gets boring.',
    docsPath: 'What-is-Incrementalism%3F/',
  },
  {
    id: 'increm-list',
    title: 'See the whole queue',
    body: 'The IncRem List shows priorities, due dates and history — and edits them inline.',
    docsPath: 'IncRem-List-and-Main-View/',
  },
  {
    id: 'keyboard-shortcuts',
    title: 'One keystroke away',
    body: 'Alt+X, Alt+Shift+X and Alt+P cover the daily loop. Click to see the rest.',
    docsPath: 'Keyboard-Shortcuts/',
  },
  {
    id: 'study-dashboard',
    title: 'Where did the time go?',
    body: 'The Study Dashboard breaks your reviews down by document and period.',
    docsPath: 'Study-Dashboard/',
  },
  {
    id: 'settings-live-here',
    title: 'Settings, all in one place',
    body: 'The ⚙ above opens them: grouped, and each one linked to the page explaining it.',
    docsPath: 'Plugin-Settings-Reference/',
  },
];

/** Acknowledgement state, stored per knowledge base under one synced key. */
interface TipsState {
  /** Ids the user has answered "I Got It" to. */
  acknowledged: string[];
}

/**
 * Synced storage is shared across every knowledge base the user owns, so the
 * state is partitioned by KB id — the same shape as the shield history. A tip
 * dismissed while learning anatomy should not be silently pre-dismissed in a
 * knowledge base started next year.
 */
type TipsStateByKb = Record<string, TipsState>;

async function getKbId(plugin: RNPlugin): Promise<string> {
  const kb = await plugin.kb.getCurrentKnowledgeBaseData();
  return kb?._id ?? 'default';
}

export async function getAcknowledgedTipIds(plugin: RNPlugin): Promise<string[]> {
  const byKb = (await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)) || {};
  return byKb[await getKbId(plugin)]?.acknowledged ?? [];
}

export async function acknowledgeTip(plugin: RNPlugin, tipId: string): Promise<void> {
  const kbId = await getKbId(plugin);
  const byKb = (await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)) || {};
  const current = byKb[kbId]?.acknowledged ?? [];
  if (current.includes(tipId)) return;
  byKb[kbId] = { acknowledged: [...current, tipId] };
  await plugin.storage.setSynced(onboardingTipsStateKey, byKb);
}

/** Used by the "start over" affordance, and by anyone debugging the pile. */
export async function resetAcknowledgedTips(plugin: RNPlugin): Promise<void> {
  const kbId = await getKbId(plugin);
  const byKb = (await plugin.storage.getSynced<TipsStateByKb>(onboardingTipsStateKey)) || {};
  delete byKb[kbId];
  await plugin.storage.setSynced(onboardingTipsStateKey, byKb);
  await plugin.storage.setLocal(onboardingTipsSnoozeKey, 0);
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
 * Draw one tip at random from what is left. Called once per panel mount — a
 * session shows one tip and no more, whichever way the user answers it.
 */
export function pickTip(acknowledged: string[]): OnboardingTip | null {
  const pool = ONBOARDING_TIPS.filter((t) => !acknowledged.includes(t.id));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
