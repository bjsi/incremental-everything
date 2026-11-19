// lib/tag_subtree_css.ts
//
// Carries the `cloze-extract` and `ignore` editor styling down to a tagged
// Rem's DESCENDANTS, and (setting "Mark Extra Card Detail Subtrees for Custom
// CSS") marks every Extra Card Detail Rem and its descendants with
// `--in-extra-card-detail: 1`. That marker styles nothing: the user's Custom CSS
// reads it with `@container style(--in-extra-card-detail: 1) { .rem-text {…} }`
// (a custom property inherits from the container div into its row).
//
// WHY THIS CANNOT BE PLAIN CSS
//
// The static rules in lib/ui_helpers.ts match the tagged row through
// `data-rem-tags` / `data-rem-container-tags`, and both attributes carry only
// the Rem's OWN tags. The editor is a flat, absolutely positioned list: every
// Rem's container div is a root-level sibling of its ancestors' containers, so
// no descendant or child combinator can reach a subtree (see the note on
// SHOW_LEFT_BORDER_CSS in register/settings.ts). Nor can an overlay on the
// ancestor's container, whose box does span the subtree: each container is its
// own stacking context at z-index 2, painted below the descendants that follow
// it, and raising it would swallow their clicks — without the hover reveal or
// `zoom` the rules rely on.
//
// So the plugin works out which Rems sit under a tagged Rem in the open panes,
// and registers the same declarations against their `data-rem-container-id`
// (set on the same container div as `data-rem-container-tags`).
//
// COST
//
// One getDescendants() per open pane, then one getTagRems() (plus one
// hasPowerup() with the ECD marker on) per Rem that has children (a leaf has no subtree to style, so its tags are irrelevant), plus
// the pane Rem's ancestor chain for a pane zoomed inside a tagged Rem. Refreshed
// on navigation, and after edits only when they can change the answer: a Rem
// added to, moved within or deleted from the panes, or a change on a Rem that
// has children.
import { AppEvents, BuiltInPowerupCodes, ReactRNPlugin, RemId, PluginRem } from '@remnote/plugin-sdk';
import { isOperationSuppressed } from './operation_suppression';
import { getIESetting } from './settings';
import { markExtraCardDetailSubtreesSettingId } from './consts';

// Shared with the static tagged-row rules in lib/ui_helpers.ts.
export const CLOZE_EXTRACT_DIM_DECL = `
      opacity: 0.5;
      filter: grayscale(40%);
      zoom: 0.8;
      transition: all 0.2s ease-in-out;`;
export const CLOZE_EXTRACT_REVEAL_DECL = `
      opacity: 1;
      filter: grayscale(0%);`;
export const IGNORE_SHRINK_DECL = `
      font-size: 0.85rem !important;`;
// 0.65 on the text block as a whole: what the old per-element 0.88 added up to
// two or three elements deep, so hovering or focusing still visibly brings the
// text back to full strength.
export const IGNORE_DIM_DECL = `
      opacity: 0.65;`;
/**
 * What the #ignore shrink applies to, after a row selector: every element in the
 * text except KaTeX's. KaTeX sizes its inner spans in em (fraction parts, scripts,
 * line offsets); one forced size on all of them shrank formulas and overlapped
 * fractions. Skipping them lets a formula scale from the shrunk text around it.
 */
export const IGNORE_SHRINK_TARGET = '.rem-text :not(.katex, .katex *)';
/** The dim goes on the text block once: opacity on every element compounded with depth. */
export const IGNORE_DIM_TARGET = '.rem-text:not(:focus-within):not(:hover)';
/**
 * A quiet bullet for #ignore Rems: the dot shrinks and fades, but RemNote's ring
 * behind it is left alone, so a collapsed branch still shows the grey ring
 * (.rn-rem-bullet--hidden-children) and hovering still shows the hover ring. The
 * core sits in a 200-unit viewBox (ring r=100); the CSS `r` property resizes it.
 */
export const QUIET_BULLET_TARGET = '.rem-bullet__core';
export const QUIET_BULLET_DECL = `
      r: 36px;
      fill-opacity: 0.28;`;
export const QUIET_BULLET_COLLAPSED_TARGET = '.rn-rem-bullet--hidden-children .rem-bullet__core';
export const QUIET_BULLET_COLLAPSED_DECL = `
      fill-opacity: 0.55;`;

const STYLESHEET_ID = 'tag-subtree-styling';
const SUBTREE_TAGS = ['cloze-extract', 'ignore'] as const;
type SubtreeTag = (typeof SUBTREE_TAGS)[number];
/** Extra Card Detail is a powerup (`apu.x`), not a tag: getTagRems() never lists it. */
const ECD_KIND = 'extra-card-detail';
type SubtreeKind = SubtreeTag | typeof ECD_KIND;
/** The marker the user's Custom CSS queries; see the header. */
export const ECD_SUBTREE_PROPERTY = '--in-extra-card-detail';

const REM_CHANGE_DEBOUNCE_MS = 1500;
/** How many buffered changes to look up; a paste burst shares its parents. */
const MAX_PARENT_CHECKS = 20;

/** Snapshot of the open panes from the last refresh, used to filter edits. */
let knownParentById = new Map<RemId, RemId | undefined>();
let knownPaneIds = new Set<RemId>();
/** Subtree kinds of each Rem that has children, as a comparable key. */
let knownParentTags = new Map<RemId, string>();
let knownTagIdToName = new Map<RemId, SubtreeTag>();
let knownMarkEcd = false;
let refreshGeneration = 0;

function selectorFor(ids: RemId[]): string {
  return `:is(${ids.map((id) => `[data-rem-container-id="${id}"]`).join(',')})`;
}

function buildCSS(styled: Record<SubtreeKind, RemId[]>, markEcd: boolean): string {
  let css = '';
  if (markEcd) {
    // The ECD Rem's own row, wherever it is drawn (its container names its powerups).
    css += `
    [data-rem-container-tags~="${ECD_KIND}" i] { ${ECD_SUBTREE_PROPERTY}: 1; }`;
  }
  if (styled[ECD_KIND].length) {
    css += `
    ${selectorFor(styled[ECD_KIND])} { ${ECD_SUBTREE_PROPERTY}: 1; }`;
  }
  if (styled['cloze-extract'].length) {
    const sel = selectorFor(styled['cloze-extract']);
    css += `
    .rn-editor ${sel} .rem-text {${CLOZE_EXTRACT_DIM_DECL}
    }
    .rn-editor ${sel}:focus-within .rem-text,
    .rn-editor ${sel}:hover .rem-text {${CLOZE_EXTRACT_REVEAL_DECL}
    }`;
  }
  if (styled.ignore.length) {
    const sel = selectorFor(styled.ignore);
    css += `
    ${sel} ${IGNORE_SHRINK_TARGET} {${IGNORE_SHRINK_DECL}
    }
    ${sel} ${IGNORE_DIM_TARGET} {${IGNORE_DIM_DECL}
    }
    ${sel} ${QUIET_BULLET_TARGET} {${QUIET_BULLET_DECL}
    }
    ${sel} ${QUIET_BULLET_COLLAPSED_TARGET} {${QUIET_BULLET_COLLAPSED_DECL}
    }`;
  }
  return css;
}

/** The subtree tags among a Rem's tags, in SUBTREE_TAGS order. */
function matching(tagIds: Set<RemId>, tagIdToName: Map<RemId, SubtreeTag>): SubtreeTag[] {
  return SUBTREE_TAGS.filter((name) => [...tagIds].some((id) => tagIdToName.get(id) === name));
}

/** A Rem's subtree tags, plus the ECD kind when it is marked and the Rem has the powerup. */
async function kindsOf(
  rem: PluginRem,
  tagIdToName: Map<RemId, SubtreeTag>,
  markEcd: boolean
): Promise<SubtreeKind[]> {
  const [tagIds, isEcd] = await Promise.all([
    tagIdToName.size ? tagIdsOf(rem) : Promise.resolve(new Set<RemId>()),
    markEcd ? rem.hasPowerup(BuiltInPowerupCodes.ExtraCardDetail).catch(() => false) : Promise.resolve(false),
  ]);
  const kinds: SubtreeKind[] = matching(tagIds, tagIdToName);
  if (isEcd) kinds.push(ECD_KIND);
  return kinds;
}

async function tagIdsOf(rem: PluginRem): Promise<Set<RemId>> {
  try {
    return new Set(((await rem.getTagRems()) || []).map((t) => t._id));
  } catch {
    return new Set();
  }
}

/**
 * Recomputes the descendant rules for every open pane and re-registers the
 * stylesheet. Must run in the index widget: registerCSS is a no-op elsewhere.
 */
export async function refreshTagSubtreeCSS(plugin: ReactRNPlugin): Promise<void> {
  const generation = ++refreshGeneration;
  try {
    const tagRems = await Promise.all(SUBTREE_TAGS.map((name) => plugin.rem.findByName([name], null)));
    const tagIdToName = new Map<RemId, SubtreeTag>();
    tagRems.forEach((tag, i) => tag && tagIdToName.set(tag._id, SUBTREE_TAGS[i]));

    const markEcd = !!(await getIESetting(plugin, markExtraCardDetailSubtreesSettingId));

    const parentById = new Map<RemId, RemId | undefined>();
    const parentTagKeys = new Map<RemId, string>();
    const styled: Record<SubtreeKind, Set<RemId>> = {
      'cloze-extract': new Set(),
      ignore: new Set(),
      [ECD_KIND]: new Set(),
    };

    const paneRemIds = tagIdToName.size || markEcd ? await plugin.window.getOpenPaneRemIds() : [];
    const paneIds = new Set(paneRemIds);
    for (const paneRemId of paneIds) {
      const paneRem = await plugin.rem.findOne(paneRemId);
      if (!paneRem) continue;
      const descendants = (await paneRem.getDescendants()) || [];

      const childrenOf = new Map<RemId, RemId[]>();
      for (const d of descendants) {
        parentById.set(d._id, d.parent ?? undefined);
        if (!d.parent) continue;
        const siblings = childrenOf.get(d.parent);
        if (siblings) siblings.push(d._id);
        else childrenOf.set(d.parent, [d._id]);
      }

      // A pane zoomed inside a tagged Rem shows only that Rem's descendants.
      const inherited = new Set<SubtreeKind>();
      let cursor: PluginRem | undefined = paneRem;
      for (let depth = 0; cursor && depth < 50; depth++) {
        (await kindsOf(cursor, tagIdToName, markEcd)).forEach((n) => inherited.add(n));
        cursor = cursor.parent ? await plugin.rem.findOne(cursor.parent) : undefined;
      }

      const parentsInPane = descendants.filter((d) => childrenOf.has(d._id));
      // Rems with children in several panes are simply read once per pane.
      const parentTags = new Map<RemId, SubtreeKind[]>();
      await Promise.all(
        parentsInPane.map(async (p) => parentTags.set(p._id, await kindsOf(p, tagIdToName, markEcd)))
      );

      const walk = (remId: RemId, fromAbove: Set<SubtreeKind>) => {
        const own = parentTags.get(remId) ?? [];
        const forChildren = own.length ? new Set([...fromAbove, ...own]) : fromAbove;
        for (const childId of childrenOf.get(remId) ?? []) {
          forChildren.forEach((n) => styled[n].add(childId));
          walk(childId, forChildren);
        }
      };
      walk(paneRemId, inherited);
      parentTags.forEach((tags, id) => parentTagKeys.set(id, tags.join(',')));
    }

    if (generation !== refreshGeneration) return; // a newer refresh superseded this one
    knownPaneIds = paneIds;
    knownParentById = parentById;
    knownParentTags = parentTagKeys;
    knownTagIdToName = tagIdToName;
    knownMarkEcd = markEcd;
    await plugin.app.registerCSS(
      STYLESHEET_ID,
      buildCSS(
        { 'cloze-extract': [...styled['cloze-extract']], ignore: [...styled.ignore], [ECD_KIND]: [...styled[ECD_KIND]] },
        markEcd
      )
    );
  } catch (e) {
    console.error('[TagSubtreeCSS] refresh failed:', e);
  }
}

/**
 * Refreshes on navigation, and after edits that can move a Rem into or out of
 * a tagged subtree. Called from registerEventListeners (index widget).
 */
export function registerTagSubtreeCSSListeners(plugin: ReactRNPlugin) {
  plugin.event.addListener(AppEvents.URLChange, undefined, async () => {
    if ((await plugin.window.getURL()).includes('/flashcards')) return;
    await refreshTagSubtreeCSS(plugin);
  });

  const pendingRemIds = new Set<RemId>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = async () => {
    const changed = [...pendingRemIds];
    pendingRemIds.clear();
    if (await isOperationSuppressed(plugin)) return;
    if ((await plugin.window.getURL()).includes('/flashcards')) return;

    // Only a change that can move a Rem into or out of a tagged subtree
    // matters: a Rem added to, moved within or deleted from the panes, or a
    // (un)tag on a Rem that has children. Text edits do not, and neither do
    // changes elsewhere in the KB (sync, other plugin writes), which fire this
    // event too.
    const sample = changed.slice(0, MAX_PARENT_CHECKS);
    const rems = await Promise.all(sample.map((id) => plugin.rem.findOne(id)));
    const checks = await Promise.all(
      rems.map(async (rem, i) => {
        const id = sample[i];
        if (knownPaneIds.has(id)) return true; // e.g. the open document itself was tagged
        const parent = rem?.parent ?? undefined;
        if (!knownParentById.has(id)) {
          return !!parent && (knownParentById.has(parent) || knownPaneIds.has(parent));
        }
        if (parent !== knownParentById.get(id)) return true;
        const tagKey = knownParentTags.get(id);
        if (tagKey === undefined || !rem) return false; // a leaf: its tags style nothing
        return (await kindsOf(rem, knownTagIdToName, knownMarkEcd)).join(',') !== tagKey;
      })
    );
    const stale = checks.some(Boolean);
    if (stale) await refreshTagSubtreeCSS(plugin);
  };

  plugin.event.addListener(AppEvents.GlobalRemChanged, undefined, (data) => {
    pendingRemIds.add(data.remId);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), REM_CHANGE_DEBOUNCE_MS);
  });
}
