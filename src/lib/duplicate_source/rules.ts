// The duplicate-source decisions and index updates that need no RemNote call.
// Shared with the popup, which must not import the plugin-side module.

/** Comparison key of a URL (url_key.ts) → Incremental or Dismissed Rems with that page as a source. */
export type SourceUrlIndex = Record<string, string[]>;

export type SourceMatchStatus = 'incremental' | 'dismissed';

export interface SourceMatch {
  remId: string;
  name: string;
  status: SourceMatchStatus;
  /** The address this Rem has, which may be another form of the one being added. */
  url: string;
}

/** A Rem about to become Incremental, and the Rems already holding its page. */
export interface DuplicateGroup {
  remId: string;
  name: string;
  url: string;
  matches: SourceMatch[];
}

export type DuplicateChoice =
  | { kind: 'proceed' }
  | { kind: 'skip' }
  | { kind: 'cancel' }
  | { kind: 'open'; remId: string };

export interface DuplicateDecision {
  requestId: string;
  choice: DuplicateChoice;
}

/** Adds a Rem under each key. Returns the same object when nothing changed, so a write can be skipped. */
export function withRemUnderKeys(index: SourceUrlIndex, keys: string[], remId: string): SourceUrlIndex {
  const missing = keys.filter((key) => !index[key]?.includes(remId));
  if (!missing.length) return index;
  const next = { ...index };
  for (const key of missing) next[key] = [...(next[key] ?? []), remId];
  return next;
}

/** Removes (key, Rem) pairs, and any key left empty. Returns the same object when nothing changed. */
export function withoutEntries(
  index: SourceUrlIndex,
  entries: Array<{ key: string; remId: string }>
): SourceUrlIndex {
  const present = entries.filter(({ key, remId }) => index[key]?.includes(remId));
  if (!present.length) return index;
  const next = { ...index };
  for (const { key, remId } of present) {
    const left = (next[key] ?? []).filter((id) => id !== remId);
    if (left.length) next[key] = left;
    else delete next[key];
  }
  return next;
}

/** Adds everything in `added` to `index`. Returns the same object when nothing changed. */
export function mergedIndex(index: SourceUrlIndex, added: SourceUrlIndex): SourceUrlIndex {
  let next = index;
  for (const [key, remIds] of Object.entries(added)) {
    for (const remId of remIds) next = withRemUnderKeys(next, [key], remId);
  }
  return next;
}

/**
 * The index after a full scan. Scanned Rems are replaced by what the scan found,
 * which drops a source they no longer have. Entries of Rems outside the scan
 * survive only if `survivors` vouches for them: those are Rems made Incremental
 * during the scan, as opposed to ones that have since lost both powerups.
 */
export function indexAfterScan(
  current: SourceUrlIndex,
  scanned: SourceUrlIndex,
  scannedRemIds: ReadonlySet<string>,
  survivors: ReadonlySet<string>
): SourceUrlIndex {
  let next: SourceUrlIndex = { ...scanned };
  for (const [key, remIds] of Object.entries(current)) {
    for (const remId of remIds) {
      if (!scannedRemIds.has(remId) && survivors.has(remId)) next = withRemUnderKeys(next, [key], remId);
    }
  }
  return next;
}

/** Rems of `current` that the scan did not reach. */
export function unscannedRemIds(current: SourceUrlIndex, scannedRemIds: ReadonlySet<string>): string[] {
  const ids = new Set(Object.values(current).flat());
  return [...ids].filter((id) => !scannedRemIds.has(id));
}

/** Which of the requested Rems go on to become Incremental after the user's choice. */
export function remsToKeep<T extends { _id: string }>(
  rems: T[],
  groups: DuplicateGroup[],
  choice: DuplicateChoice
): T[] {
  if (choice.kind === 'proceed') return rems;
  if (choice.kind !== 'skip') return [];
  const duplicated = new Set(groups.map((group) => group.remId));
  return rems.filter((rem) => !duplicated.has(rem._id));
}
