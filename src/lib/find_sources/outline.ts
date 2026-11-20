/**
 * RemNote's outline style, read as statements (plans/implemented/SOURCE_FINDER_PLAN.md, phase 4).
 *
 * Notes often split one sentence across Rems: a lead-in ending with ":" (or a dangling
 * "…composta por") and its children as list items ("alteração na densidade da água",
 * "fatores do navio e"). Neither is a statement alone. Find Sources and Check Statement
 * judge the group as one — lead-in plus items — and pin a passage on the item it
 * supports, or on the lead-in. Pure functions over a small tree model, so they can be
 * tested; lib/find_sources builds the model from Rems.
 */

export interface OutlineNode {
  id: string;
  /** The Rem's text without pins (front, then back). */
  text: string;
  children: OutlineNode[];
  /** A heading (H1–H3): a title, never a statement or a list item. */
  heading?: boolean;
}

export interface StatementMember {
  remId: string;
  text: string;
}

export interface Statement {
  /** The Rem the statement belongs to: the lead-in of a group, or the Rem itself. */
  headId: string;
  /** The statement as one text: lead-in and items joined. */
  text: string;
  /** The list items (empty for a single Rem). */
  members: StatementMember[];
}

/** A list item is short; longer children are statements of their own. */
export const MAX_ITEM_WORDS = 30;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Words a lead-in can end on, waiting for its list ("…determinada por", "…such as"). */
const DANGLING = new Set(
  (
    'de do da dos das por pelo pela como que são é a o as os e ou entre em para com incluem inclui ' +
    'of by as are is include includes including and or to with for the such'
  ).split(' ')
);

/** Ends with ":" or with a word that waits for a list. */
export function isLeadIn(text: string): boolean {
  const t = text.trim();
  if (/[:：]$/.test(t)) return true;
  const last = t.toLowerCase().match(/([\p{L}]+)$/u)?.[1];
  return !!last && DANGLING.has(last);
}

/**
 * A node's children as list items, each with its own nested list folded in; null
 * when they are not a list (no children, a long child, a heading, or a child with
 * children that are not a list of its own).
 */
function listItems(node: OutlineNode): string[] | null {
  if (!isLeadIn(node.text) || !node.children.length) return null;
  const items: string[] = [];
  for (const child of node.children) {
    if (child.heading || !child.text.trim() || words(child.text) > MAX_ITEM_WORDS) return null;
    if (child.children.length) {
      const nested = listItems(child);
      if (!nested) return null;
      items.push(joinList(child.text, nested, false));
    } else {
      items.push(child.text.trim());
    }
  }
  return items;
}

/**
 * Lead-in and items as one sentence, keeping the author's own punctuation: an item
 * that already ends with "," ";" or a conjunction ("fatores do navio e") runs on;
 * others are separated with ";". The last item keeps its full stop.
 */
export function joinList(lead: string, items: string[], close = true): string {
  let out = lead.trim();
  items.forEach((raw, k) => {
    const item = raw.trim();
    const last = k === items.length - 1;
    const runsOn = /[,;]$/.test(item) || /\s(e|ou|and|or)$/i.test(item);
    out += ' ' + (last ? item.replace(/[,;]$/, '') : runsOn ? item : `${item.replace(/\.$/, '')};`);
  });
  if (close && !/[.!?)\]”"]$/.test(out)) out += '.';
  return out;
}

/** Every Rem in a list group (items and nested items), in order. */
function groupMembers(node: OutlineNode): StatementMember[] {
  return node.children.flatMap((c) => [{ remId: c.id, text: c.text.trim() }, ...groupMembers(c)]);
}

/** The node as a list group (lead-in + items), or null when it is not one. */
export function groupOf(node: OutlineNode): Statement | null {
  const items = listItems(node);
  if (!items) return null;
  return { headId: node.id, text: joinList(node.text, items), members: groupMembers(node) };
}

/**
 * The statements of a tree, in order: a list group as one statement (its items are not
 * looked at again); any other Rem with at least `minWords` words, not a heading and not
 * the caption of a media Rem, on its own, then its children.
 */
export function statementsInOutline(roots: OutlineNode[], minWords: number): Statement[] {
  const out: Statement[] = [];
  const walk = (node: OutlineNode) => {
    const group = groupOf(node);
    if (group) {
      out.push(group);
      return;
    }
    // A Rem whose children are all media without text (an audio, an image) is their caption.
    const caption = node.children.length > 0 && node.children.every((c) => !c.text.trim() && !c.children.length);
    if (!node.heading && !caption && words(node.text) >= minWords) {
      out.push({ headId: node.id, text: node.text.trim(), members: [] });
    }
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/**
 * Where a passage's pin goes in a group: on the one item whose text holds all the words
 * of `covers` (the part of the statement the passage supports), else on the lead-in.
 */
export function pinTarget(statement: Statement, covers: string): string {
  const wanted = covers.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!wanted?.length || !statement.members.length) return statement.headId;
  const holds = (text: string) => {
    const have = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    let k = 0;
    for (const w of have) if (w === wanted[k]) k++;
    return k === wanted.length;
  };
  const hits = statement.members.filter((m) => holds(m.text));
  return hits.length === 1 ? hits[0].remId : statement.headId;
}
