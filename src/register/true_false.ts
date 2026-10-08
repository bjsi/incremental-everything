import { AppEvents, PluginRem, ReactRNPlugin, SelectionType } from '@remnote/plugin-sdk';
import { getEffectiveSelection } from '../lib/editor_selection';
import { safeRemTextToString } from '../lib/pdfUtils';
import { backTextWithVerdict, referencedRemIds, Verdict, VERDICT_MARK } from '../lib/true_false';

/* True/False cards: a statement whose answer is "true" or "false".

   Two powerups mark the verdict. They double as the CSS hook: the queue paints
   a large true/false badge over the statement on the front (the same badge for
   both verdicts, so it gives nothing away) and a green or red answer block on
   the back; the editor swaps the bullet for a small ✔ / ✘.

   The slug in data-rem-tags / data-queue-rem-container-tags comes from the
   powerup NAME (see queue_display_powerups.ts), so "TFT" → `tft`, "TFF" → `tff`. */
export const TRUE_FALSE_TRUE_POWERUP_CODE = 'trueFalseTrue';
export const TRUE_FALSE_FALSE_POWERUP_CODE = 'trueFalseFalse';

const POWERUP_CODE: Record<Verdict, string> = {
  true: TRUE_FALSE_TRUE_POWERUP_CODE,
  false: TRUE_FALSE_FALSE_POWERUP_CODE,
};

const GREEN = '#16a34a';
const RED = '#dc2626';

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

const CHECK_PATH = 'M-9 0l6 7 12-14';
const CROSS_PATH = 'M-8-8l16 16m0-16l-16 16';
const stroke = (path: string, at: string, width: number) =>
  `<path transform="translate(${at})" d="${path}" fill="none" stroke="#fff" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

// Front badge: one disc split into a green ✔ half and a red ✘ half.
const QUESTION_BADGE = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath></defs>` +
    `<g clip-path="url(#c)">` +
    `<polygon points="0,0 64,0 0,64" fill="#22c55e"/>` +
    `<polygon points="64,0 64,64 0,64" fill="#ef4444"/>` +
    `<line x1="64" y1="0" x2="0" y2="64" stroke="#fff" stroke-width="4"/>` +
    `</g>` +
    stroke(CHECK_PATH, '21 22', 5) +
    stroke(CROSS_PATH, '43 43', 5) +
    `</svg>`
);

const discIcon = (color: string, path: string) =>
  svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<circle cx="16" cy="16" r="15" fill="${color}"/>` +
      stroke(path, '16 16', 3.5) +
      `</svg>`
  );
const whiteIcon = (path: string) =>
  svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${stroke(path, '16 16', 4)}</svg>`);

const queueCard = (slug: string) => `.rn-question-rem[data-queue-rem-container-tags~="${slug}"]`;
const editorRow = (slug: string) => `.rn-editor__rem__body[data-rem-tags~="${slug}"]`;

const verdictCss = (slug: string, color: string, tint: string, path: string) => `
/* Editor: the bullet becomes the verdict. The ring stays, so a collapsed branch
   still shows. The bullet sits several wrappers below the row (confirmed
   2026-10-03 against live DOM), hence the descendant combinator; the editor is
   a flat list, so a row never contains another row's bullet. */
${editorRow(slug)} .rem-bullet__container {
  background: ${discIcon(color, path)} center / 16px 16px no-repeat;
}
${editorRow(slug)} .rem-bullet__container .rem-bullet__core {
  fill: transparent;
}
${editorRow(slug)} .hierarchy-editor__tag-bar__tag {
  display: none;
}

/* Queue, answer shown: the statement and its answer sit in a tinted, bordered
   block closed by a full-width verdict bar. The colour stays inside that block:
   the rest of the card belongs to RemNote and to plugin widgets. */
.rn-queue__content--answer-revealed ${queueCard(slug)} {
  background-color: rgba(${tint}, 0.2);
  box-shadow: inset 0 0 0 3px ${color};
}
.rn-queue__content--answer-revealed ${queueCard(slug)}::after {
  content: "";
  display: block;
  height: 72px;
  margin-top: 14px;
  border-radius: 10px;
  background: ${color} ${whiteIcon(path)} center / 52px 52px no-repeat;
}
`;

const ANY_QUEUE_CARD = `:is(${queueCard('tft')}, ${queueCard('tff')})`;

const TRUE_FALSE_CSS = `
/* Queue, both sides. The block has its final box on the front already, so
   nothing moves when the answer is revealed. The left padding clears the
   bullet, which hangs 24px to the left of the text. */
.rn-queue__content ${ANY_QUEUE_CARD} {
  border-radius: 14px;
  padding: 16px 18px 16px 36px;
}
/* The badge that says "this is a true-or-false question". */
.rn-queue__content ${ANY_QUEUE_CARD}::before {
  content: "";
  display: block;
  height: 84px;
  margin: 4px 0 14px;
  background: ${QUESTION_BADGE} center / contain no-repeat;
}
/* The answer, on its own line and large. Both variants render it as the
   revealed fill-in-the-blank inside the question Rem (confirmed 2026-10-03). */
.rn-queue__content--answer-revealed ${ANY_QUEUE_CARD} .rn-fill-in-blank--revealed {
  display: block;
  margin-top: 8px;
  font-size: 1.6em;
  line-height: 1.3;
  font-weight: 700;
}
${verdictCss('tft', GREEN, '22, 163, 74', CHECK_PATH)}
${verdictCss('tff', RED, '220, 38, 38', CROSS_PATH)}
`;

/* Card Cluster cards. A cluster is drawn by its own renderer (both variants),
   which prints no tag attribute and no Rem id: the tag-keyed rules above have
   nothing to match (saved DOM + app.asar, 2026-10-03). The one hook is
   `cluster-answer-container`, set on the Rem being tested on both sides of the
   card. So the verdict comes from the plugin instead: this stylesheet is
   registered for the verdict of the card on screen, or emptied.

   The row is the container's own first line; its children (the other cards of
   the cluster) sit in a sibling div and stay unstyled. Beautiful's row is
   `.min-w-0.items-start`, Compact's is `.justify-between`. */
const CLUSTER_CSS_ID = 'true-false-cluster-card';
// Written by src/widgets/card_info_bar.tsx on every card and cluster sibling.
const CLUSTER_VISIBLE_REM_KEY = 'clusterVisibleRemId';
const CLUSTER_ROW =
  '.cluster-answer-container:not(.cluster-answer-container .cluster-answer-container) > :is(.min-w-0.items-start, .justify-between)';

const VERDICT_STYLE: Record<Verdict, { color: string; tint: string; path: string }> = {
  true: { color: GREEN, tint: '22, 163, 74', path: CHECK_PATH },
  false: { color: RED, tint: '220, 38, 38', path: CROSS_PATH },
};

const clusterCss = ({ color, tint, path }: { color: string; tint: string; path: string }) => `
.rn-queue__content ${CLUSTER_ROW} {
  flex-wrap: wrap;
  border-radius: 14px;
  padding: 12px 16px;
}
.rn-queue__content ${CLUSTER_ROW}::before {
  content: "";
  flex: 0 0 100%;
  height: 84px;
  margin: 4px 0 10px;
  background: ${QUESTION_BADGE} center / contain no-repeat;
}
.rn-queue__content--answer-revealed ${CLUSTER_ROW} {
  background-color: rgba(${tint}, 0.2);
  box-shadow: inset 0 0 0 3px ${color};
}
.rn-queue__content--answer-revealed ${CLUSTER_ROW}::after {
  content: "";
  flex: 0 0 100%;
  height: 72px;
  margin-top: 14px;
  border-radius: 10px;
  background: ${color} ${whiteIcon(path)} center / 52px 52px no-repeat;
}
/* Compact draws a bullet in front of the statement (span > .rn-rem-bullet inside
   the row's .relative wrapper; saved DOM, 2026-10-03). Inside the framed block it
   ended up alone on a line above the statement, and the frame already marks the
   card, so it is dropped. Beautiful's dot is a different element and stays. */
.rn-queue__content ${CLUSTER_ROW}.justify-between > .relative > span:has(> .rn-rem-bullet) {
  display: none;
}
/* The answer: Beautiful prints it as the viewer after the "→" delimiter,
   Compact as the revealed fill-in-the-blank. */
.rn-queue__content--answer-revealed ${CLUSTER_ROW} :is(.mx-2 ~ .RichTextViewer, .rn-fill-in-blank--revealed) {
  display: block;
  margin-top: 8px;
  font-size: 1.6em;
  line-height: 1.3;
  font-weight: 700;
}
`;

// What is registered now, so a card with the same verdict (or none, the usual
// case) costs no registerCSS call.
let clusterCssVerdict: Verdict | null = null;

async function setClusterCardCss(plugin: ReactRNPlugin, verdict: Verdict | null) {
  if (verdict === clusterCssVerdict) return;
  clusterCssVerdict = verdict;
  await plugin.app.registerCSS(CLUSTER_CSS_ID, verdict ? clusterCss(VERDICT_STYLE[verdict]) : '');
}

async function applyClusterCardCss(plugin: ReactRNPlugin, remId: string | undefined) {
  let verdict: Verdict | null = null;
  try {
    const rem = remId ? await plugin.rem.findOne(remId) : undefined;
    if (rem) {
      if (await rem.hasPowerup(TRUE_FALSE_TRUE_POWERUP_CODE)) verdict = 'true';
      else if (await rem.hasPowerup(TRUE_FALSE_FALSE_POWERUP_CODE)) verdict = 'false';
    }
  } catch {
    /* unreadable Rem: clear */
  }
  await setClusterCardCss(plugin, verdict);
}

/* Index-only (registerCSS no-ops from other iframes).

   Two sources for "the Rem on screen":
   - `clusterVisibleRemId`, the session key card_info_bar already broadcasts for
     every card it sits under. It is the only one that follows the siblings of a
     cluster: QueueLoadCard fires once for the whole cluster, not per sibling.
   - QueueLoadCard, for cards the bar is not mounted on (its powerupFilter is
     cardPriority, so a card with no priority never broadcasts). */
export function registerTrueFalseClusterTracker(plugin: ReactRNPlugin) {
  plugin.track(async (rp) => {
    const remId = await rp.storage.getSession<string>(CLUSTER_VISIBLE_REM_KEY);
    await applyClusterCardCss(plugin, remId);
  });
  plugin.event.addListener(AppEvents.QueueLoadCard, undefined, async () => {
    // getCurrentCard, not the event payload: QueueLoadCard also fires id-less.
    const card = await plugin.queue.getCurrentCard().catch(() => undefined);
    await applyClusterCardCss(plugin, card?.remId);
  });
  plugin.event.addListener(AppEvents.QueueExit, undefined, () => setClusterCardCss(plugin, null));
  // Leaving by navigation fires no QueueExit. Only while something is registered
  // is the URL read at all; entering a queue also fires URLChange, hence the check.
  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    if (!clusterCssVerdict) return;
    const url = await plugin.window.getURL();
    if (!url.includes('/flashcards') && !url.startsWith('/need_to_learn')) {
      await setClusterCardCss(plugin, null);
    }
  });
}

export async function registerTrueFalsePowerups(plugin: ReactRNPlugin) {
  await plugin.app.registerPowerup({
    name: 'TFT',
    code: TRUE_FALSE_TRUE_POWERUP_CODE,
    description: 'A True/False card whose statement is TRUE. Set with the "True/False: Mark as True" command.',
    options: { slots: [] },
  });
  await plugin.app.registerPowerup({
    name: 'TFF',
    code: TRUE_FALSE_FALSE_POWERUP_CODE,
    description: 'A True/False card whose statement is FALSE. Set with the "True/False: Mark as False" command.',
    options: { slots: [] },
  });
  await plugin.app.registerCSS('true-false-cards', TRUE_FALSE_CSS);
}

/* The current card while practising, else the editor selection (Omnibar-proof),
   else the focused Rem. */
async function targetRems(plugin: ReactRNPlugin): Promise<{ rems: PluginRem[]; inQueue: boolean }> {
  const url = await plugin.window.getURL();
  const currentCard = await plugin.queue.getCurrentCard();
  const live = await plugin.editor.getSelection();
  if (url.includes('/flashcards') && currentCard && !live) {
    const rem = await plugin.rem.findOne(currentCard.remId);
    return { rems: rem ? [rem] : [], inQueue: true };
  }

  const sel = await getEffectiveSelection(plugin);
  if (sel?.type === SelectionType.Rem && sel.remIds?.length) {
    return { rems: (await plugin.rem.findMany(sel.remIds)) || [], inQueue: false };
  }
  if (sel?.type === SelectionType.Text && sel.remId) {
    const rem = await plugin.rem.findOne(sel.remId);
    return { rems: rem ? [rem] : [], inQueue: false };
  }
  const focused = await plugin.focus.getFocusedRem();
  return { rems: focused ? [focused] : [], inQueue: false };
}

async function markVerdict(plugin: ReactRNPlugin, rem: PluginRem, verdict: Verdict) {
  const back = rem.backText as any[] | undefined;
  const refText: Record<string, string> = {};
  for (const id of referencedRemIds(back)) {
    const target = await plugin.rem.findOne(id);
    if (target) refText[id] = await safeRemTextToString(plugin, target.text);
  }

  const next = backTextWithVerdict(back, verdict, refText);
  if (next) {
    const hadBack = !!back && back.length > 0;
    await rem.setBackText(next);
    // A statement is only ever asked forwards: the bare mark is no prompt.
    if (!hadBack) await rem.setPracticeDirection('forward');
  }

  await rem.removePowerup(POWERUP_CODE[verdict === 'true' ? 'false' : 'true']);
  await rem.addPowerup(POWERUP_CODE[verdict]);
}

/* Text import cannot name a powerup: pasting "#[[TFT]]" resolves the name among
   ordinary Rems and, finding none, creates a plain tag Rem called TFT. That tag
   slugifies to the same `tft`, so the card is already styled; this swaps it for
   the powerup, writes the mark, and deletes the plain tag once nothing uses it. */
async function convertPlainTags(plugin: ReactRNPlugin) {
  const { rems: targets } = await targetRems(plugin);
  const scope = new Map<string, PluginRem>();
  for (const rem of targets) {
    scope.set(rem._id, rem);
    for (const child of await rem.getDescendants()) scope.set(child._id, child);
  }

  const powerupIds = new Set<string>();
  for (const code of Object.values(POWERUP_CODE)) {
    const powerup = await plugin.powerup.getPowerupByCode(code);
    if (powerup) powerupIds.add(powerup._id);
  }

  const plainTags = new Map<string, PluginRem>();
  let converted = 0;
  for (const rem of scope.values()) {
    for (const tag of await rem.getTagRems()) {
      if (powerupIds.has(tag._id)) continue;
      const name = (await safeRemTextToString(plugin, tag.text)).trim().toUpperCase();
      const verdict: Verdict | null = name === 'TFT' ? 'true' : name === 'TFF' ? 'false' : null;
      if (!verdict) continue;
      await rem.removeTag(tag._id);
      await markVerdict(plugin, rem, verdict);
      plainTags.set(tag._id, tag);
      converted++;
    }
  }

  for (const tag of plainTags.values()) {
    const stillUsed = (await tag.taggedRem()).length > 0 || (await tag.getChildrenRem()).length > 0;
    if (!stillUsed) await tag.remove();
  }

  await plugin.app.toast(
    converted === 0
      ? `No plain TFT / TFF tags found (${scope.size} Rem${scope.size === 1 ? '' : 's'} checked).`
      : `Converted ${converted} True/False card${converted === 1 ? '' : 's'}.`
  );
}

async function runMarkCommand(plugin: ReactRNPlugin, verdict: Verdict) {
  const { rems, inQueue } = await targetRems(plugin);
  if (rems.length === 0) {
    await plugin.app.toast('No Rem selected — place your cursor in the statement first.');
    return;
  }
  for (const rem of rems) await markVerdict(plugin, rem, verdict);

  const what = rems.length === 1 ? 'Marked' : `${rems.length} Rems marked`;
  await plugin.app.toast(
    `${what} ${VERDICT_MARK[verdict]} ${verdict === 'true' ? 'True' : 'False'}` +
      (inQueue ? ' (shows next time you see this card).' : '.')
  );
}

export async function registerTrueFalseCommands(plugin: ReactRNPlugin) {
  await plugin.app.registerCommand({
    id: `${TRUE_FALSE_TRUE_POWERUP_CODE}Cmd`,
    name: 'True/False: Mark as True',
    description: 'Turn the selected statement(s) into True/False cards answered ✅, keeping whatever the back already holds.',
    quickCode: 'tft',
    action: async () => runMarkCommand(plugin, 'true'),
  });

  await plugin.app.registerCommand({
    id: `${TRUE_FALSE_FALSE_POWERUP_CODE}Cmd`,
    name: 'True/False: Mark as False',
    description: 'Turn the selected statement(s) into True/False cards answered ❌, keeping whatever the back already holds.',
    quickCode: 'tff',
    action: async () => runMarkCommand(plugin, 'false'),
  });

  await plugin.app.registerCommand({
    id: 'trueFalseConvertTagsCmd',
    name: 'True/False: Convert Pasted Tags',
    description:
      'After importing cards from text with #[[TFT]] / #[[TFF]]: turn those plain tags into True/False cards. Works on the selected Rems, or on the focused Rem and everything under it.',
    quickCode: 'tfc',
    action: async () => convertPlainTags(plugin),
  });

  await plugin.app.registerCommand({
    id: 'trueFalseClearCmd',
    name: 'True/False: Remove Marking',
    description: 'Remove the True/False styling from the selected Rem(s). The card and its back text are left as they are.',
    quickCode: 'tfx',
    action: async () => {
      const { rems } = await targetRems(plugin);
      for (const rem of rems) {
        await rem.removePowerup(TRUE_FALSE_TRUE_POWERUP_CODE);
        await rem.removePowerup(TRUE_FALSE_FALSE_POWERUP_CODE);
      }
      if (rems.length > 0) await plugin.app.toast('True/False marking removed.');
    },
  });
}
