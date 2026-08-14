import { RNPlugin } from '@remnote/plugin-sdk';
import { onboardingTipsStateKey, onboardingTipsSnoozeKey } from './consts';

/**
 * The tip pile behind the Incremental Plugin sidebar hub.
 *
 * A tip is one small thing the plugin can do, phrased so it can be acted on
 * immediately. The user has three answers to each:
 *
 *  - **I Got It** — acknowledged, and never shown again. Persisted per knowledge
 *    base in synced storage, so it survives reloads and follows the user across
 *    devices.
 *  - **✕** — not now. The tip stays in the pile and can resurface later; the
 *    panel goes quiet for {@link TIP_SNOOZE_MS} first so dismissing it does not
 *    hand back another tip on the same breath.
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
  /** One short line, sentence case, no trailing period. */
  title: string;
  /** Two sentences at most — this renders in a sidebar column. */
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
    title: 'Make your first Incremental Rem',
    body: 'Put the cursor on any Rem — with nothing selected — and press Alt+X (Opt+X on Mac). It joins your queue and comes back on a schedule you control, no flashcard needed.',
    docsPath: 'Getting-Started/#method-2-keyboard-shortcut',
  },
  {
    id: 'extract-while-reading',
    title: 'Extract instead of re-reading',
    body: 'The same Alt+X, with text selected, pulls that passage out as its own Incremental Rem. The long source shrinks a little on every pass.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-extract-altx--altshiftx',
  },
  {
    id: 'cloze-an-extract',
    title: 'Turn an extract into a flashcard',
    body: 'Once an extract is short and clear, select the key words and press Alt+Z to cloze it. Reading turns into remembering without leaving the Rem.',
    docsPath: 'IR-Flow--Reading-Extracting-and-Clozing/#create-cloze-altz--altshiftz',
  },
  {
    id: 'set-a-priority',
    title: 'Priority decides what you actually see',
    body: 'Press Alt+P on any Incremental Rem to set its priority. The queue draws by priority, so this is the one knob that changes what your day looks like.',
    docsPath: 'Prioritization-&-Sorting/#setting-priorities',
  },
  {
    id: 'priority-inheritance',
    title: 'Set priority once, for a whole document',
    body: 'Priority is inherited: give a document a priority and everything inside it starts there. You only override the exceptions.',
    docsPath: 'Prioritization-&-Sorting/#priority-inheritance-system',
  },
  {
    id: 'sorting-criteria',
    title: 'Tune the mix of cards and reading',
    body: 'Sorting Criteria sets how much of your queue is flashcards, how much is incremental reading, and how much randomness sits on top. Presets save the mixes you like.',
    docsPath: 'Prioritization-&-Sorting/#sorting-criteria',
  },
  {
    id: 'answer-buttons',
    title: 'The queue buttons do more than "next"',
    body: 'From an Incremental Rem you can reschedule, dismiss, change priority, or open it in the editor — without breaking your review session.',
    docsPath: 'Reviewing-Items-in-the-Queue/#the-answer-buttons',
  },
  {
    id: 'review-in-editor',
    title: 'Review outside the queue',
    body: 'Long reading is painful in a flashcard slot. Open the item in the editor, work at your own pace, and record the repetition when you are done.',
    docsPath: 'Reviewing-Items-in-the-Editor/',
  },
  {
    id: 'priority-review-document',
    title: 'Beat the "too many cards" queue',
    body: 'A Priority Review Document collects the highest-priority items in a scope into one document you can work through deliberately, instead of hoping the queue serves them.',
    docsPath: 'Priority-Review-Document/',
  },
  {
    id: 'pdf-workflow',
    title: 'Read PDFs incrementally',
    body: 'A PDF can be an Incremental Rem: the plugin remembers your page, and highlights become extracts you can prioritise like anything else.',
    docsPath: 'PDF-Incremental-Reading-Workflow/',
  },
  {
    id: 'incremental-adoption',
    title: 'Add one tool at a time',
    body: 'You do not have to adopt the whole plugin at once. Start with Incremental Rems and priority; bring in extracts, PDFs and dashboards when the current habit is boring.',
    docsPath: 'What-is-Incrementalism%3F/',
  },
  {
    id: 'increm-list',
    title: 'See every Incremental Rem at once',
    body: 'The IncRem List shows what is queued in a document — priorities, due dates, history — and lets you edit priorities inline instead of one Rem at a time.',
    docsPath: 'IncRem-List-and-Main-View/',
  },
  {
    id: 'keyboard-shortcuts',
    title: 'Most of this is one keystroke away',
    body: 'Alt+X, Alt+Z, Alt+P and Ctrl+J cover the daily loop. The shortcuts page lists the rest, including the ones not bound by default.',
    docsPath: 'Keyboard-Shortcuts/',
  },
  {
    id: 'study-dashboard',
    title: 'Check what you actually studied',
    body: 'The Study Dashboard breaks your reviews down by document and period, so you can see where the time went rather than guess.',
    docsPath: 'Study-Dashboard/',
  },
  {
    id: 'settings-live-here',
    title: 'Every setting is in one window',
    body: 'The gear at the top of this panel opens the plugin’s own settings — grouped, searchable, and each one linked to the page that explains it.',
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
 * Draw one tip at random from what is left, optionally avoiding the one just
 * answered so "I Got It" cannot hand back the same card twice in a row.
 */
export function pickTip(acknowledged: string[], excludeId?: string): OnboardingTip | null {
  const pool = ONBOARDING_TIPS.filter((t) => !acknowledged.includes(t.id) && t.id !== excludeId);
  // Only the exclusion emptied it — better to repeat the last tip than to show
  // nothing while tips remain.
  const fallback = ONBOARDING_TIPS.filter((t) => !acknowledged.includes(t.id));
  const source = pool.length > 0 ? pool : fallback;
  if (source.length === 0) return null;
  return source[Math.floor(Math.random() * source.length)];
}
