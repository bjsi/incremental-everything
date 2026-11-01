// What the Chrome companion's plugin side decides without calling RemNote.

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  position: number;
}

export interface PageState {
  extracts: Array<{ remId: string; anchor: Anchor; opId?: string }>;
  readPoint?: { anchor: Anchor; percent: number; at: number };
  /** Section path joined with \u0001 → its Rem. */
  sections: Record<string, string>;
  /** Rem → where it sits in the page's text, which keeps children in reading order. */
  order: Record<string, number>;
}

export const emptyPageState = (): PageState => ({ extracts: [], sections: {}, order: {} });

/**
 * Pages share a fixed number of synced keys, since a plugin may have only 1000 of
 * them in all. A key is created only once a page lands in it, so nothing is
 * stored for anyone not using the extension.
 */
export const COMPANION_SHARD_COUNT = 32;

export const companionShardKey = (shard: number) => `companion_pages_${shard}`;

export function shardOfPage(pageKey: string): number {
  let hash = 5381;
  for (let i = 0; i < pageKey.length; i++) hash = ((hash * 33) ^ pageKey.charCodeAt(i)) >>> 0;
  return hash % COMPANION_SHARD_COUNT;
}

/** Below RemNote's limit for one synced key, which is 896K UTF-16 characters. */
export const MAX_SHARD_CHARACTERS = 850_000;

/** Where a child belongs among its siblings, by its position in the page's text. */
export function indexInReadingOrder(
  childIds: string[],
  position: number,
  order: Record<string, number>
): number {
  const at = childIds.findIndex((id) => (order[id] ?? -1) > position);
  return at === -1 ? childIds.length : at;
}

/** Whether the children with a known position are in the page's order. */
export function isInReadingOrder(childIds: string[], order: Record<string, number>): boolean {
  const positions = childIds.map((id) => order[id]).filter((p) => p !== undefined);
  return positions.every((p, i) => i === 0 || positions[i - 1] <= p);
}

export type MarkdownPiece =
  | { markdown: string }
  | { image: { url: string; width?: number; height?: number } };

/**
 * Splits out the extension's image tokens, `![alt](url =WxH)`. RemNote's Markdown
 * parser turns an image into a link to it, so the plugin builds these itself. Text
 * that only looks like one cannot match: the extension escapes `[` in page text.
 */
export function splitMarkdownImages(markdown: string): MarkdownPiece[] {
  const pieces: MarkdownPiece[] = [];
  const token = /!\[(?:\\.|[^\]\\])*\]\((https?:[^\s)]+)(?: =(\d+)x(\d+))?\)/g;
  let last = 0;
  for (let match = token.exec(markdown); match; match = token.exec(markdown)) {
    if (match.index > last) pieces.push({ markdown: markdown.slice(last, match.index) });
    const [, url, width, height] = match;
    pieces.push({ image: { url, ...(width && height ? { width: Number(width), height: Number(height) } : {}) } });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) pieces.push({ markdown: markdown.slice(last) });
  return pieces;
}
