// What the Chrome companion's plugin side decides without calling RemNote.

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  position: number;
}

export interface PageState {
  /** `highlight`: added with Add Highlight, so the Rem was never made Incremental. */
  extracts: Array<{ remId: string; anchor: Anchor; opId?: string; kind?: 'highlight' }>;
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

/**
 * A page's entry within its shard. Synced keys are shared by all of an account's
 * knowledge bases, while a Rem exists in only one of them, so each KB keeps its own
 * record of a page. An entry under the bare page key dates from before this.
 */
export const companionEntryKey = (kbId: string, pageKey: string) => `${kbId}|${pageKey}`;

export function shardOfPage(pageKey: string): number {
  let hash = 5381;
  for (let i = 0; i < pageKey.length; i++) hash = ((hash * 33) ^ pageKey.charCodeAt(i)) >>> 0;
  return hash % COMPANION_SHARD_COUNT;
}

/** The Rems a page record from before the per-KB entries refers to. */
export function remIdsOfPage(page: Partial<PageState>): string[] {
  return [...new Set([...(page.extracts ?? []).map((extract) => extract.remId), ...Object.values(page.sections ?? {})])];
}

const pickOwned = <T>(record: Record<string, T>, isOwned: (key: string, value: T) => boolean, wanted: boolean) =>
  Object.fromEntries(Object.entries(record).filter(([key, value]) => isOwned(key, value) === wanted));

/**
 * Moves what a KB can vouch for out of a record shared by all KBs, and leaves the
 * rest for the KB it belongs to. A record that names no Rem at all, so only a read
 * point, goes to the first KB that opens the page, as nothing says whose it was.
 * Returns no `claimed` when nothing here belongs to this KB.
 */
export function claimLegacyPage(
  legacy: Partial<PageState>,
  ownedRemIds: Set<string>,
  current: PageState
): { claimed?: PageState; rest?: PageState } {
  const old = { ...emptyPageState(), ...legacy };
  const owned = (remId: string) => ownedRemIds.has(remId);
  const extracts = old.extracts.filter((extract) => owned(extract.remId));
  const sections = pickOwned(old.sections, (_path, remId) => owned(remId), true);
  const hasRems = remIdsOfPage(old).length > 0;
  if (hasRems && !extracts.length && !Object.keys(sections).length) return { rest: old };

  const known = new Set(current.extracts.map((extract) => extract.remId));
  const claimed: PageState = {
    extracts: [...current.extracts, ...extracts.filter((extract) => !known.has(extract.remId))],
    sections: { ...sections, ...current.sections },
    order: { ...pickOwned(old.order, (remId) => owned(remId), true), ...current.order },
    readPoint: current.readPoint ?? old.readPoint,
  };
  const rest: PageState = {
    extracts: old.extracts.filter((extract) => !owned(extract.remId)),
    sections: pickOwned(old.sections, (_path, remId) => owned(remId), false),
    order: pickOwned(old.order, (remId) => owned(remId), false),
  };
  return { claimed, rest: remIdsOfPage(rest).length ? rest : undefined };
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
