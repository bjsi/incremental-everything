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

const TEXT_FORMATS = ['b', 'l', 'u', 'sup', 'sub', 'q', 'str'] as const;
const isWebAddress = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//.test(url);

/**
 * Keeps only what an extract may contain. This came from a web page by way of the
 * extension, so anything else, such as a reference to another Rem, is dropped.
 */
export function sanitizeExtractRichText(items: unknown): Array<string | Record<string, unknown>> {
  if (!Array.isArray(items)) return [];
  const clean: Array<string | Record<string, unknown>> = [];
  for (const item of items as any[]) {
    if (typeof item === 'string') {
      if (item) clean.push(item);
    } else if (item?.i === 'm' && typeof item.text === 'string' && item.text) {
      const element: Record<string, unknown> = { i: 'm', text: item.text };
      for (const format of TEXT_FORMATS) if (item[format] === true) element[format] = true;
      if (isWebAddress(item.iUrl)) element.iUrl = item.iUrl;
      clean.push(element);
    } else if (item?.i === 'x' && typeof item.text === 'string' && item.text) {
      clean.push({ i: 'x', text: item.text, ...(item.block === true ? { block: true } : {}) });
    } else if (item?.i === 'i' && isWebAddress(item.url)) {
      clean.push({
        i: 'i',
        url: item.url,
        ...(Number.isFinite(item.width) && Number.isFinite(item.height) ? { width: item.width, height: item.height } : {}),
        ...(typeof item.title === 'string' && item.title ? { title: item.title } : {}),
      });
    }
  }
  return clean;
}
