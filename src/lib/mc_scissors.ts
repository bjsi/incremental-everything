// lib/mc_scissors.ts
//
// Multiple-choice scissors: a ✂ beside each option of a native
// multiple-choice card, which strikes that option through so the user can
// eliminate alternatives before answering. Clicking the option itself answers
// (and, with one correct answer, rates) the card, so the scissors must live
// outside it.
//
// No plugin code can reach the host DOM, and nothing tells a plugin where the
// options are. The browser does the placing instead:
//   - every native option carries data-test="multiple-choice-option-choice-{i}"
//     in DISPLAY order (after RemNote's shuffle), so CSS names each one as an
//     anchor (--ie-mc-{i});
//   - one floating widget is opened per option. Each sits in a bare
//     <div class="absolute z-50"> whose iframe src carries widgetName=mc_scissors,
//     and they render in the order they were opened, so
//     :nth-child(k of :has(iframe[src*=…])) picks the k-th one;
//   - CSS anchor positioning pins the k-th wrapper beside the k-th option, so
//     variable option heights, scrolling and resizing are all handled by layout.
// The strike itself is CSS keyed on the same display index. Nothing is saved:
// the state lives in session storage and is dropped when the card changes.
//
// The same controller opens the True/False answer sheet (widgets/mc_assertions.tsx)
// when the question numbers its statements I., II., III. (see lib/mc_assertions.ts).
//
// Each is gated by its own Queue Display setting ("Scissors on Multiple-Choice
// Cards", "True/False Answer Sheet on Multiple-Choice Cards"), read on every card
// load. The widgets' keys live in consts.ts so their iframes (one per option for
// the scissors) do not load this file's imports.

import { AppEvents, BuiltInPowerupCodes, ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import {
  mcAssertionLabelsKey as MC_ASSERTION_LABELS_KEY,
  mcAssertionMarksKey as MC_ASSERTION_MARKS_KEY,
  mcAssertionSheetSettingId,
  mcAssertionsWidgetId as MC_ASSERTIONS_WIDGET,
  mcScissorsIdsKey as MC_SCISSORS_IDS_KEY,
  mcScissorsSettingId,
  mcScissorsStruckKey as MC_SCISSORS_STRUCK_KEY,
  mcScissorsWidgetId as MC_SCISSORS_WIDGET,
} from './consts';
import { assertionLabels, richTextPlain } from './mc_assertions';
import { getIESetting } from './settings';

const ANCHOR_CSS_ID = 'mc-scissors-anchors';
const STRIKE_CSS_ID = 'mc-scissors-strike';
// More options than this get no scissors; the CSS is generated up to it.
const MAX_OPTIONS = 12;
const LOG = '[MC Scissors]';

const optionSel = (i: number) => `[data-test="multiple-choice-option-choice-${i}"]`;
const wrapperSel = (i: number) =>
  `div.absolute.z-50:nth-child(${i + 1} of div.absolute.z-50:has(iframe[src*="widgetName=${MC_SCISSORS_WIDGET}"]))`;

/* position: fixed so the containing block is the viewport: an absolutely
   positioned wrapper's containing block is somewhere near #main, and the queue
   may sit inside positioned boxes that come later in tree order, which would
   make the options unacceptable anchors.

   The anchor() fallbacks stack the scissors at the top right, so a browser
   that cannot resolve the anchors still shows them somewhere usable. */
function anchorCss(): string {
  let css = '';
  for (let i = 0; i < MAX_OPTIONS; i++) {
    css += `
${optionSel(i)} { anchor-name: --ie-mc-${i}; }
${wrapperSel(i)} {
  position: fixed !important;
  position-anchor: --ie-mc-${i};
  top: anchor(--ie-mc-${i} center, ${80 + 36 * i}px) !important;
  right: calc(anchor(--ie-mc-${i} left, 16px) + 6px) !important;
  left: auto !important;
  bottom: auto !important;
  translate: 0 -50%;
  /* Hidden while its option is scrolled fully out of view. */
  position-visibility: anchors-visible;
}`;
  }
  css += `
.rn-question-rem { anchor-name: --ie-mc-question; }`;
  return css;
}

const SHEET_CSS_ID = 'mc-assertions-sheet';
const SHEET_WRAPPER = `div.absolute.z-50:has(iframe[src*="widgetName=${MC_ASSERTIONS_WIDGET}"])`;

/* The answer sheet: one column, its top level with the question's top and its
   right edge on the scissors' column, so it reads as part of the same gutter.

   Its boxes are spaced like the scissors: the column is made `rows` times the
   options' average pitch tall, (last centre - first centre) / (options - 1),
   and the widget spreads its rows evenly over that height. In `bottom`,
   anchor(X) is the distance from the viewport's bottom edge to X, so the
   options' pitch is anchor(first) - anchor(last) over (options - 1). The frame
   and the host elements between it and the wrapper are stretched to fill it. */
function sheetCss(rows: number, options: number): string {
  const last = Math.min(options, MAX_OPTIONS) - 1;
  const pitch =
    last > 0
      ? `((anchor(--ie-mc-0 center, 0px) - anchor(--ie-mc-${last} center, 0px)) / ${last})`
      : '36px';
  return `
${SHEET_WRAPPER} {
  position: fixed !important;
  position-anchor: --ie-mc-question;
  top: anchor(--ie-mc-question top, 80px) !important;
  right: calc(anchor(--ie-mc-0 left, 60px) + 6px) !important;
  bottom: calc(anchor(--ie-mc-question top, 0px) - ${rows} * max(${pitch}, 30px)) !important;
  left: auto !important;
  height: auto !important;
  display: flex !important;
  flex-direction: column;
  position-visibility: anchors-visible;
}
${SHEET_WRAPPER} :is(div, iframe) {
  flex: 1 1 auto;
  height: 100% !important;
  min-height: 0 !important;
}`;
}

function strikeCss(struck: number[]): string {
  return struck
    .map(
      (i) => `
${optionSel(i)} { opacity: 0.5; }
${optionSel(i)} span.w-full,
${optionSel(i)} span.w-full * { text-decoration: line-through; }`
    )
    .join('\n');
}

let openIds: string[] = [];
let sheetId: string | undefined;
let sheetCssOn = false;
let shownForCardId: string | undefined;
// QueueLoadCard fires in bursts (and id-less); one sync at a time.
let chain: Promise<void> = Promise.resolve();

const anythingOpen = () => openIds.length > 0 || !!sheetId;

async function closeAll(plugin: RNPlugin): Promise<void> {
  const ids = sheetId ? [...openIds, sheetId] : openIds;
  openIds = [];
  sheetId = undefined;
  shownForCardId = undefined;
  await plugin.storage.setSession(MC_SCISSORS_IDS_KEY, []);
  await plugin.storage.setSession(MC_SCISSORS_STRUCK_KEY, []);
  await plugin.storage.setSession(MC_ASSERTION_LABELS_KEY, []);
  await plugin.storage.setSession(MC_ASSERTION_MARKS_KEY, []);
  if (sheetCssOn) {
    sheetCssOn = false;
    await plugin.app.registerCSS(SHEET_CSS_ID, '');
  }
  for (const id of ids) {
    try {
      await plugin.window.closeFloatingWidget(id);
    } catch {
      /* already gone */
    }
  }
}

interface McCard {
  /** Options shown as card items. */
  optionCount: number;
  /** Numerals of the question's numbered assertions; [] when it has none. */
  assertions: string[];
}

/** What the current card offers, or undefined when it is not a multiple-choice card. */
async function readMcCard(plugin: RNPlugin, remId: string): Promise<McCard | undefined> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem || !(await rem.hasPowerup(BuiltInPowerupCodes.MultipleChoice))) return undefined;
  const children = await rem.getChildrenRem();
  const flags = await Promise.all(children.map((c) => c.isCardItem()));
  return {
    optionCount: flags.filter(Boolean).length,
    assertions: assertionLabels(richTextPlain(rem.text)),
  };
}

async function sync(plugin: RNPlugin): Promise<void> {
  const card = await plugin.queue.getCurrentCard().catch(() => undefined);
  if (card && card._id === shownForCardId) return;
  if (anythingOpen()) await closeAll(plugin);
  if (!card) return;
  const [scissorsOn, sheetOn] = await Promise.all([
    getIESetting(plugin, mcScissorsSettingId),
    getIESetting(plugin, mcAssertionSheetSettingId),
  ]);
  if (!scissorsOn && !sheetOn) return;

  const mc = await readMcCard(plugin, card.remId).catch((e) => {
    console.warn(`${LOG} Could not read the card's Rem:`, e);
    return undefined;
  });
  if (!mc || mc.optionCount === 0) return;
  shownForCardId = card._id;

  if (sheetOn && mc.assertions.length) {
    await plugin.storage.setSession(MC_ASSERTION_LABELS_KEY, mc.assertions);
    await plugin.app.registerCSS(SHEET_CSS_ID, sheetCss(mc.assertions.length, mc.optionCount));
    sheetCssOn = true;
    sheetId = await plugin.window.openFloatingWidget(MC_ASSERTIONS_WIDGET, { top: 80, right: 60 }, undefined, false);
    console.log(`${LOG} Answer sheet opened for ${mc.assertions.length} assertions.`);
  }

  if (!scissorsOn) return;
  const count = mc.optionCount;
  if (count > MAX_OPTIONS) {
    console.log(`${LOG} ${count} options, more than ${MAX_OPTIONS}: no scissors.`);
    return;
  }
  const ids: string[] = [];
  // In order, one at a time: nth-child relies on the opening order.
  for (let i = 0; i < count; i++) {
    ids.push(
      await plugin.window.openFloatingWidget(MC_SCISSORS_WIDGET, { top: 80 + 36 * i, right: 16 }, undefined, false)
    );
  }
  openIds = ids;
  await plugin.storage.setSession(MC_SCISSORS_IDS_KEY, ids);
  console.log(`${LOG} ${count} scissors opened for card ${card._id}.`);
}

const queue = (plugin: RNPlugin, job: () => Promise<void>) => {
  chain = chain.then(job).catch((e) => console.warn(`${LOG} Sync failed:`, e));
  return chain;
};

/* Index-only (registerCSS no-ops from other iframes). */
export async function registerMcScissors(plugin: ReactRNPlugin): Promise<void> {
  await plugin.app.registerCSS(ANCHOR_CSS_ID, anchorCss());

  plugin.track(async (rp) => {
    const struck = (await rp.storage.getSession<number[]>(MC_SCISSORS_STRUCK_KEY)) ?? [];
    await plugin.app.registerCSS(STRIKE_CSS_ID, strikeCss(struck));
  });

  // getCurrentCard, not the payload: QueueLoadCard also fires id-less.
  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, () => queue(plugin, () => sync(plugin)));
  plugin.event.addListener(AppEvents.QueueExit, undefined, () => queue(plugin, () => closeAll(plugin)));
  // Leaving by navigation fires no QueueExit.
  plugin.event.addListener(AppEvents.URLChange, undefined, () =>
    queue(plugin, async () => {
      if (!anythingOpen()) return;
      const url = await plugin.window.getURL();
      if (!url.includes('/flashcards') && !url.startsWith('/need_to_learn')) await closeAll(plugin);
    })
  );
}
