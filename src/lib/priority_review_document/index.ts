import { RNPlugin, PluginRem, RichTextInterface, RemId } from '@remnote/plugin-sdk';
import { priorityGraphPowerupCode } from '../consts';
import { saveReviewGraphData, ReviewGraphData } from './graph_data';
import { ensureReviewQueueTagPinnedOnce } from './sidebar_pin';
import { SelectedItem } from './select';
import { readChildren } from './children';

export { hasCardClusterPowerup } from './cluster';
export type { SkippedPausedItem, SkippedAncestorItem, SkippedCoolingItem, SelectedItem } from './select';

/** Name of the plain tag on every review document. */
export const PRD_TAG_NAME = 'Priority Review Queue';
/** Names of the plain tags on each entry. */
export const INC_TAG_NAME = 'INC';
export const FC_TAG_NAME = 'FC';

// Helper function to find or create a tag
export async function findOrCreateTag(plugin: RNPlugin, tagName: string): Promise<PluginRem | undefined> {
  let tag = await plugin.rem.findByName([tagName], null);
  if (!tag) {
    tag = await plugin.rem.createRem();
    if (tag) {
      await tag.setText([tagName]);
    }
  }
  return tag;
}

/**
 * Checks whether a Rem has the "Priority Review Queue" tag, meaning the document
 * should behave as a Priority Review queue (special queue scope, history, etc.).
 */
export async function isPriorityReviewDocument(rem: PluginRem): Promise<boolean> {
  const tags = await rem.getTagRems();
  if (!tags?.length) {
    return false;
  }

  return tags.some((tag) => {
    const text = tag.text;
    const tagTextString =
      typeof text === 'string'
        ? text
        : Array.isArray(text)
          ? text.join('')
          : '';
    return tagTextString.includes(PRD_TAG_NAME);
  });
}

/**
 * Parses the original scope identifier embedded in a review document title.
 *
 * The title is expected to contain either a portal reference to the original scope
 * or the literal text "Full Knowledge Base".
 * - Returns the referenced Rem ID when the portal is present.
 * - Returns `null` when the title explicitly indicates the full knowledge base.
 * - Returns `undefined` when the title cannot be parsed so callers can fall back safely.
 */
export async function extractOriginalScopeFromPriorityReview(
  reviewDocRem: PluginRem
): Promise<string | null | undefined> {
  const reviewDocTitle = reviewDocRem.text;
  if (!reviewDocTitle || reviewDocTitle.length === 0) {
    console.warn('Priority Review Document has no title content to parse for scope.');
    return undefined;
  }

  for (const element of reviewDocTitle) {
    if (typeof element === 'object' && element !== null) {
      if ('i' in element && element.i === 'q' && '_id' in element) {
        return element._id as string;
      }
    }
  }

  const textContent = reviewDocTitle.join('');
  if (textContent.includes('Full Knowledge Base')) {
    return null;
  }

  console.warn('Could not extract scope from Priority Review Document title');
  return undefined;
}

// --- document writers, shared by the snapshot creator and the Priority Queue ---

/** `<prefix> - [scope ref] - <suffix>`, or `<prefix> - Full Knowledge Base - <suffix>`. */
export async function buildReviewDocTitle(
  plugin: RNPlugin,
  prefix: string,
  scopeRemId: string | null,
  suffix?: string
): Promise<RichTextInterface> {
  const tail = suffix ? ` - ${suffix}` : '';
  if (scopeRemId) {
    const scopeRem = await plugin.rem.findOne(scopeRemId);
    if (scopeRem) return [`${prefix} - `, { i: 'q', _id: scopeRem._id }, tail];
    return [`${prefix} - Document${tail}`];
  }
  return [`${prefix} - Full Knowledge Base${tail}`];
}

/** Tags the document, files it under the tag Rem, offers the sidebar pin once. */
export async function attachToReviewQueueTag(plugin: RNPlugin, doc: PluginRem): Promise<void> {
  const reviewQueueTag = await findOrCreateTag(plugin, PRD_TAG_NAME);
  if (!reviewQueueTag) return;
  await doc.addTag(reviewQueueTag);
  // Live under the tag Rem rather than at the top level of the knowledge base:
  // RemNote lists a review document under its tag as an instance either way,
  // and a document queue already gathers a tag's instances with their
  // descendants, so this only keeps the documents together.
  await doc.setParent(reviewQueueTag);
  await ensureReviewQueueTagPinnedOnce(plugin, reviewQueueTag);
}

/** One child per item: a single Rem reference, tagged INC or FC. Appends. */
export async function writeEntries(plugin: RNPlugin, doc: PluginRem, items: SelectedItem[]): Promise<number> {
  const incTag = await findOrCreateTag(plugin, INC_TAG_NAME);
  const fcTag = await findOrCreateTag(plugin, FC_TAG_NAME);
  let written = 0;
  for (const item of items) {
    const childRem = await plugin.rem.createRem();
    if (!childRem) continue;
    await childRem.setParent(doc);
    await childRem.setText([{ i: 'q', _id: item.rem._id }]);
    const typeTag = item.type === 'incremental' ? incTag : fcTag;
    if (typeTag) await childRem.addTag(typeTag);
    written++;
  }
  return written;
}

export interface GraphItem {
  type: 'incremental' | 'flashcard';
  priority: number;
  percentile: number;
}

/** Twenty 5-point bins over absolute priority and over relative percentile. */
export function buildGraphData(items: GraphItem[], randomnessPct: { incRem: number; card: number }): ReviewGraphData {
  const createBins = (style: 'integer' | 'range') =>
    Array(20)
      .fill(0)
      .map((_, i) => ({
        range: style === 'integer' ? (i === 19 ? '95-100' : `${i * 5}-${i * 5 + 4}`) : `${i * 5}-${(i + 1) * 5}`,
        incRem: 0,
        card: 0,
      }));
  const binsAbsolute = createBins('integer');
  const binsRelative = createBins('range');
  for (const item of items) {
    const absIndex = Math.min(Math.floor(Math.max(0, Math.min(100, item.priority)) / 5), 19);
    const relIndex = Math.min(Math.floor(Math.max(0, Math.min(100, item.percentile)) / 5), 19);
    const key = item.type === 'incremental' ? 'incRem' : 'card';
    binsAbsolute[absIndex][key]++;
    binsRelative[relIndex][key]++;
  }
  return { bins: binsAbsolute, binsRelative, stats: randomnessPct };
}

/** Finds the document's graph Rem, or creates it as the second child. */
export async function findOrCreateGraphRem(plugin: RNPlugin, doc: PluginRem): Promise<PluginRem | null> {
  const children = await readChildren(plugin, doc);
  for (const child of children) {
    try {
      if (await child.hasPowerup(priorityGraphPowerupCode)) return child;
    } catch {
      /* ignore */
    }
  }
  const graphRem = await plugin.rem.createRem();
  if (!graphRem) return null;
  await graphRem.setParent(doc);
  await graphRem.setText(['Priority Distribution Graph']);
  await graphRem.addPowerup(priorityGraphPowerupCode);
  return graphRem;
}

export async function writeGraph(plugin: RNPlugin, doc: PluginRem, data: ReviewGraphData): Promise<void> {
  const graphRem = await findOrCreateGraphRem(plugin, doc);
  // Stored on the graph Rem itself rather than under a synced key, so it is
  // deleted along with the document.
  if (graphRem) await saveReviewGraphData(plugin, graphRem, data);
}

/** Finds the document's metadata code block (text starts with `Scope: `), or creates it as the first child. */
export async function findOrCreateMetadataRem(plugin: RNPlugin, doc: PluginRem): Promise<PluginRem | null> {
  const children = await readChildren(plugin, doc);
  for (const child of children) {
    const text = Array.isArray(child.text) ? child.text.filter((t) => typeof t === 'string').join('') : '';
    if (text.startsWith('Scope: ')) return child;
  }
  const metadataRem = await plugin.rem.createRem();
  if (!metadataRem) return null;
  await metadataRem.setText(['Scope: ']);
  await metadataRem.setIsCode(true);
  await metadataRem.setParent(doc);
  return metadataRem;
}
