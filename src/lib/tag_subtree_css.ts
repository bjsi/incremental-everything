// lib/tag_subtree_css.ts
//
// Carries the `cloze-extract` and `ignore` editor styling down to a tagged
// Rem's DESCENDANTS.
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
// One getDescendants() per open pane, then one getTagRems() per Rem that has
// children (a leaf has no subtree to style, so its tags are irrelevant), plus
// the pane Rem's ancestor chain for a pane zoomed inside a tagged Rem. Refreshed
// on navigation, and after edits only when they can change the answer: a Rem
// added to, moved within or deleted from the panes, or a change on a Rem that
// has children.
import { AppEvents, ReactRNPlugin, RemId, PluginRem } from '@remnote/plugin-sdk';
import { isOperationSuppressed } from './operation_suppression';

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
export const IGNORE_DIM_DECL = `
      opacity: 0.88;`;

const STYLESHEET_ID = 'tag-subtree-styling';
const SUBTREE_TAGS = ['cloze-extract', 'ignore'] as const;
type SubtreeTag = (typeof SUBTREE_TAGS)[number];

const REM_CHANGE_DEBOUNCE_MS = 1500;
/** How many buffered changes to look up; a paste burst shares its parents. */
const MAX_PARENT_CHECKS = 20;

/** Snapshot of the open panes from the last refresh, used to filter edits. */
let knownParentById = new Map<RemId, RemId | undefined>();
let knownPaneIds = new Set<RemId>();
/** Subtree tags of each Rem that has children, as a comparable key. */
let knownParentTags = new Map<RemId, string>();
let knownTagIdToName = new Map<RemId, SubtreeTag>();
let refreshGeneration = 0;

function selectorFor(ids: RemId[]): string {
  return `:is(${ids.map((id) => `[data-rem-container-id="${id}"]`).join(',')})`;
}

function buildCSS(styled: Record<SubtreeTag, RemId[]>): string {
  let css = '';
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
    ${sel} .rem-text * {${IGNORE_SHRINK_DECL}
    }
    ${sel} .rem-text:not(:focus-within):not(:hover) * {${IGNORE_DIM_DECL}
    }`;
  }
  return css;
}

/** The subtree tags among a Rem's tags, in SUBTREE_TAGS order. */
function matching(tagIds: Set<RemId>, tagIdToName: Map<RemId, SubtreeTag>): SubtreeTag[] {
  return SUBTREE_TAGS.filter((name) => [...tagIds].some((id) => tagIdToName.get(id) === name));
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

    const parentById = new Map<RemId, RemId | undefined>();
    const parentTagKeys = new Map<RemId, string>();
    const styled: Record<SubtreeTag, Set<RemId>> = { 'cloze-extract': new Set(), ignore: new Set() };

    const paneRemIds = tagIdToName.size ? await plugin.window.getOpenPaneRemIds() : [];
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
      const inherited = new Set<SubtreeTag>();
      let cursor: PluginRem | undefined = paneRem;
      for (let depth = 0; cursor && depth < 50; depth++) {
        matching(await tagIdsOf(cursor), tagIdToName).forEach((n) => inherited.add(n));
        cursor = cursor.parent ? await plugin.rem.findOne(cursor.parent) : undefined;
      }

      const parentsInPane = descendants.filter((d) => childrenOf.has(d._id));
      // Rems with children in several panes are simply read once per pane.
      const parentTags = new Map<RemId, SubtreeTag[]>();
      await Promise.all(
        parentsInPane.map(async (p) => parentTags.set(p._id, matching(await tagIdsOf(p), tagIdToName)))
      );

      const walk = (remId: RemId, fromAbove: Set<SubtreeTag>) => {
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
    await plugin.app.registerCSS(
      STYLESHEET_ID,
      buildCSS({ 'cloze-extract': [...styled['cloze-extract']], ignore: [...styled.ignore] })
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
        return matching(await tagIdsOf(rem), knownTagIdToName).join(',') !== tagKey;
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
