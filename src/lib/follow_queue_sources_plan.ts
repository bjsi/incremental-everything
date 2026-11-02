import type { RemIdWindowTree } from '@remnote/plugin-sdk';

/** Most sources a card opens at once; four panes still leave each PDF readable. */
export const MAX_FOLLOWED_SOURCES = 4;

/** One source pin of a card, resolved to the document that holds it. */
export interface PinnedSource {
  hostRemId: string;
  /** The highlight to scroll to; null when the pin is to the document itself. */
  highlightRemId: string | null;
}

/**
 * One entry per distinct source, in the order the card first mentions them, up to
 * the limit. Several pins into one source scroll to the first pin that has a
 * highlight to scroll to.
 */
export function planFollowedSources(pins: PinnedSource[]): PinnedSource[] {
  const byHost = new Map<string, PinnedSource>();
  for (const pin of pins) {
    const known = byHost.get(pin.hostRemId);
    if (known) {
      known.highlightRemId ??= pin.highlightRemId;
    } else if (byHost.size < MAX_FOLLOWED_SOURCES) {
      byHost.set(pin.hostRemId, { ...pin });
    }
  }
  return [...byHost.values()];
}

/**
 * The pane layout for the sources: one fills the window, two sit side by side,
 * three give the first the left half, and four form a grid.
 */
export function followedSourcesLayout(remIds: string[]): RemIdWindowTree {
  const [a, b, c, d] = remIds;
  const split = (direction: 'row' | 'column', first: RemIdWindowTree, second: RemIdWindowTree) => ({
    direction,
    first,
    second,
    splitPercentage: 50,
  });
  if (d) return split('row', split('column', a, b), split('column', c, d));
  if (c) return split('row', a, split('column', b, c));
  if (b) return split('row', a, b);
  return a;
}

/** True when the panes already show exactly these sources, whatever their arrangement. */
export function sameSources(openRemIds: string[], remIds: string[]): boolean {
  const open = new Set(openRemIds);
  return open.size === new Set(remIds).size && remIds.every((id) => open.has(id));
}
