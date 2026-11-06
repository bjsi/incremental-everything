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
// Gated by the Queue Display setting "Scissors on Multiple-Choice Cards", read
// on every card load. The widget's keys live in consts.ts so its iframe (one per
// option) does not load this file's imports.

import { AppEvents, BuiltInPowerupCodes, ReactRNPlugin, RNPlugin } from '@remnote/plugin-sdk';
import {
  mcScissorsIdsKey as MC_SCISSORS_IDS_KEY,
  mcScissorsSettingId,
  mcScissorsStruckKey as MC_SCISSORS_STRUCK_KEY,
  mcScissorsWidgetId as MC_SCISSORS_WIDGET,
} from './consts';
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
  return css;
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
let shownForCardId: string | undefined;
// QueueLoadCard fires in bursts (and id-less); one sync at a time.
let chain: Promise<void> = Promise.resolve();

async function closeAll(plugin: RNPlugin): Promise<void> {
  const ids = openIds;
  openIds = [];
  shownForCardId = undefined;
  await plugin.storage.setSession(MC_SCISSORS_IDS_KEY, []);
  await plugin.storage.setSession(MC_SCISSORS_STRUCK_KEY, []);
  for (const id of ids) {
    try {
      await plugin.window.closeFloatingWidget(id);
    } catch {
      /* already gone */
    }
  }
}

/** Number of options when the current card is a multiple-choice card, else 0. */
async function optionCount(plugin: RNPlugin, remId: string): Promise<number> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem || !(await rem.hasPowerup(BuiltInPowerupCodes.MultipleChoice))) return 0;
  const children = await rem.getChildrenRem();
  const flags = await Promise.all(children.map((c) => c.isCardItem()));
  return flags.filter(Boolean).length;
}

async function sync(plugin: RNPlugin): Promise<void> {
  const card = await plugin.queue.getCurrentCard().catch(() => undefined);
  if (card && card._id === shownForCardId) return;
  if (openIds.length) await closeAll(plugin);
  if (!card) return;
  if (!(await getIESetting(plugin, mcScissorsSettingId))) return;

  const count = await optionCount(plugin, card.remId).catch((e) => {
    console.warn(`${LOG} Could not read the card's Rem:`, e);
    return 0;
  });
  if (count === 0) return;
  if (count > MAX_OPTIONS) {
    console.log(`${LOG} ${count} options, more than ${MAX_OPTIONS}: no scissors.`);
    return;
  }

  shownForCardId = card._id;
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
      if (!openIds.length) return;
      const url = await plugin.window.getURL();
      if (!url.includes('/flashcards') && !url.startsWith('/need_to_learn')) await closeAll(plugin);
    })
  );
}
