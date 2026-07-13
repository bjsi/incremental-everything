// "Inlinize detected list" + "Break inline list into children" + restore.
//
// Motivation: a PDF highlight often captures a whole enumerated list as ONE rem,
// flattened onto a single line with the bullets/newlines dropped:
//
//   "As seguintes medidas...: 1 Aumentar... 2 Deixar claro... 3 O Oficial..."
//
// bulletize.ts can only re-bullet lines that already exist (split by "\n"). Here
// there are no line breaks at all — the structure lives in the *enumerators*
// (1, 2, 3 / a) b) c) / i. ii. iii.). This module detects that enumerator chain
// and rebuilds the structure, in two reviewable steps:
//
//   1. Inlinize — insert "\n• " before each detected marker, still ONE rem, so
//      the user can eyeball the (heuristic) split and Ctrl+Z if it's wrong.
//   2. Break to children — turn each "• " line into a child rem, caput/title
//      staying on the parent. Destructive across rems, so a snapshot of the
//      original front text + created child ids is stored first, restorable via
//      the "Restore list rem" command.
//
// Detection insight: a lone number/letter in prose is ambiguous; an *ascending*
// run (1,2,3,… / a,b,c,…) is not. So we don't split on every number — we follow
// a chain, only accepting the next *expected* value (prev+1) at a word boundary,
// preferring candidates that sit after sentence punctuation. That is what keeps
// "reduzir para 2 nós" inside an item from being mistaken for marker "2".

import { ReactRNPlugin, RichTextInterface, PluginRem } from '@remnote/plugin-sdk';
import { BULLET_PREFIX, rtPlainStr } from './bulletize';

// ---------------------------------------------------------------------------
// Detection (pure, string-only — unit-testable without the SDK)
// ---------------------------------------------------------------------------

export type ListKind = 'decimal' | 'lettered' | 'roman';

export interface DetectedList {
  kind: ListKind;
  titleEnd: number; // plain-char offset of the first marker (caput = [0, titleEnd))
  markerOffsets: number[]; // plain-char offset of each confirmed marker token
}

const ROMAN: Record<string, number> = {
  i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
};

const romanToInt = (s: string): number | null => {
  const lower = s.toLowerCase();
  let total = 0;
  let prev = 0;
  for (let k = lower.length - 1; k >= 0; k--) {
    const v = ROMAN[lower[k]];
    if (v == null) return null;
    if (v < prev) total -= v;
    else {
      total += v;
      prev = v;
    }
  }
  return total || null;
};

// The char immediately before a marker must be a separator, so we never match a
// digit/letter embedded inside a word (e.g. the "2" in "H2O" or "página2").
const isSep = (ch: string | undefined): boolean =>
  ch === undefined || /[\s.,;:)\]}"”'’(«»\-]/.test(ch);

// "Strong" = the marker sits at the end of a previous sentence/clause: skipping
// spaces backward, the preceding char is sentence punctuation (or start). Used
// to break ties when the expected value also occurs mid-sentence in an item.
const isStronglyDelimited = (S: string, pos: number): boolean => {
  let p = pos - 1;
  while (p >= 0 && /\s/.test(S[p])) p--;
  if (p < 0) return true;
  return /[.;:)\]"”]/.test(S[p]);
};

interface MarkerMatch {
  pos: number;
  value: number;
  itemStart: number; // where the item text begins (past the token + delimiter)
}

// Try to read a marker of `kind` starting exactly at `pos`. Returns null if the
// characters there aren't a valid, boundary-delimited marker of that kind.
const matchMarkerAt = (
  S: string,
  pos: number,
  kind: ListKind
): MarkerMatch | null => {
  if (!isSep(S[pos - 1])) return null;
  const rest = S.slice(pos);

  if (kind === 'decimal') {
    const m = /^(\d+)/.exec(rest);
    if (!m) return null;
    const tokenEnd = pos + m[1].length;
    // A decimal marker may carry no delimiter at all (sample: "1 Aumentar"), so
    // require token + optional delimiter + whitespace + a letter (item start).
    const dm = /^([.\-)–]?)\s+(\p{L})/u.exec(S.slice(tokenEnd));
    if (!dm) return null;
    return { pos, value: parseInt(m[1], 10), itemStart: tokenEnd + dm[0].length - 1 };
  }

  // Letters and roman numerals collide with real words, so a delimiter (". ) -")
  // is REQUIRED; the ascending chain then filters the rest.
  if (kind === 'lettered') {
    const m = /^([a-z])([.\-)–])\s+(\p{L})/iu.exec(rest);
    if (!m) return null;
    return {
      pos,
      value: m[1].toLowerCase().charCodeAt(0) - 96,
      itemStart: pos + m[0].length - 1,
    };
  }

  // roman
  const m = /^([ivxlcdm]+)([.\-)–])\s+(\p{L})/iu.exec(rest);
  if (!m) return null;
  const value = romanToInt(m[1]);
  if (value == null) return null;
  return { pos, value, itemStart: pos + m[0].length - 1 };
};

// Follow the ascending chain for one kind, starting at `startValue`. At each
// step search forward for the next expected value, preferring a strongly
// delimited occurrence over an earlier weakly delimited one.
const chainFrom = (S: string, kind: ListKind, startValue: number): MarkerMatch[] => {
  const markers: MarkerMatch[] = [];
  let expected = startValue;
  let from = 0;
  while (from < S.length) {
    let firstAny: MarkerMatch | null = null;
    let firstStrong: MarkerMatch | null = null;
    for (let p = from; p < S.length; p++) {
      const mk = matchMarkerAt(S, p, kind);
      if (!mk || mk.value !== expected) continue;
      if (!firstAny) firstAny = mk;
      if (isStronglyDelimited(S, p)) {
        firstStrong = mk;
        break;
      }
    }
    const found = firstStrong || firstAny;
    if (!found) break;
    markers.push(found);
    expected += 1;
    from = found.itemStart;
  }
  return markers;
};

// Detect a flattened enumerated list. Returns the winning chain (the longest
// across kinds) or null when nothing forms a chain of >= 2 items. v1 requires
// the chain to start at 1 / a / i — a highlight beginning mid-list is out of
// scope (and much riskier to detect).
export const detectInlineList = (S: string): DetectedList | null => {
  const kinds: ListKind[] = ['decimal', 'lettered', 'roman'];
  let best: { kind: ListKind; markers: MarkerMatch[] } | null = null;
  for (const kind of kinds) {
    const markers = chainFrom(S, kind, 1);
    if (markers.length >= 2 && (!best || markers.length > best.markers.length)) {
      best = { kind, markers };
    }
  }
  if (!best) return null;
  return {
    kind: best.kind,
    titleEnd: best.markers[0].pos,
    markerOffsets: best.markers.map((m) => m.pos),
  };
};

// ---------------------------------------------------------------------------
// Rich-text splicing (format-preserving, plain-char-offset based)
// ---------------------------------------------------------------------------

const isTextNode = (item: any): boolean =>
  typeof item === 'string' || item?.i === 'm';

// Return the rich text covering plain-char range [start, end). Text nodes are
// substringed; zero-width nodes (references, images…) are kept when their
// position falls strictly inside the range. Formatting is preserved.
const sliceRichText = (
  richText: RichTextInterface,
  start: number,
  end: number
): RichTextInterface => {
  const result: any[] = [];
  let idx = 0;
  for (const item of richText) {
    if (!isTextNode(item)) {
      if (idx >= start && idx < end) result.push(item);
      continue;
    }
    const isString = typeof item === 'string';
    const node: any = isString ? { i: 'm', text: item } : item;
    const text: string = node.text || '';
    const nodeStart = idx;
    const nodeEnd = idx + text.length;
    const from = Math.max(start, nodeStart);
    const to = Math.min(end, nodeEnd);
    if (from < to) {
      const sub = text.slice(from - nodeStart, to - nodeStart);
      result.push(isString ? sub : { ...node, text: sub });
    }
    idx = nodeEnd;
  }
  return result;
};

// Apply string insertions (offset -> text, dropped in as plain nodes) and
// single-char deletions to a rich text, in plain-char offsets. Mirrors the
// approach in bulletize.applyBulletEdits but with arbitrary insert strings.
const spliceRichText = (
  richText: RichTextInterface,
  inserts: Map<number, string>,
  dropChars: Set<number>
): RichTextInterface => {
  const result: any[] = [];
  let idx = 0;

  const pushSlice = (node: any, isString: boolean, text: string) => {
    if (!text) return;
    result.push(isString ? text : { ...node, text });
  };

  for (const item of richText) {
    if (!isTextNode(item)) {
      const ins = inserts.get(idx);
      if (ins) result.push(ins);
      result.push(item);
      continue;
    }
    const isString = typeof item === 'string';
    const node: any = isString ? { i: 'm', text: item } : item;
    const text: string = node.text || '';
    let buf = '';
    for (let k = 0; k < text.length; k++) {
      const ins = inserts.get(idx);
      if (ins) {
        pushSlice(node, isString, buf);
        buf = '';
        result.push(ins); // standalone plain node — never inherits formatting
      }
      if (!dropChars.has(idx)) buf += text[k];
      idx++;
    }
    pushSlice(node, isString, buf);
  }
  const tail = inserts.get(idx);
  if (tail) result.push(tail);
  return result;
};

// Split a rich text on literal "\n" characters into per-line segments.
const splitOnNewlines = (richText: RichTextInterface): RichTextInterface[] => {
  const S = rtPlainStr(richText);
  const segments: RichTextInterface[] = [];
  let lineStart = 0;
  for (let p = 0; p <= S.length; p++) {
    if (p === S.length || S[p] === '\n') {
      segments.push(sliceRichText(richText, lineStart, p));
      lineStart = p + 1;
    }
  }
  return segments;
};

// Strip a leading plain prefix (e.g. "• ") from a rich-text segment if present.
const stripLeadingPrefix = (
  segment: RichTextInterface,
  prefix: string
): RichTextInterface => {
  const S = rtPlainStr(segment);
  if (!S.startsWith(prefix)) return segment;
  return sliceRichText(segment, prefix.length, S.length);
};

// ---------------------------------------------------------------------------
// Command: Inlinize detected list
// ---------------------------------------------------------------------------

// Build the "\n• " insertions (collapsing the whitespace run before each marker)
// and return the rewritten rich text, or null if no list is detected.
export const inlinizeListInText = (
  richText: RichTextInterface
): RichTextInterface | null => {
  const S = rtPlainStr(richText);
  const detected = detectInlineList(S);
  if (!detected) return null;

  const hasTitle = S.slice(0, detected.titleEnd).trim().length > 0;
  const inserts = new Map<number, string>();
  const dropChars = new Set<number>();

  detected.markerOffsets.forEach((off, i) => {
    // Collapse the whitespace immediately before the marker into the prefix.
    let ws = off;
    while (ws > 0 && /\s/.test(S[ws - 1])) {
      ws--;
      dropChars.add(ws);
    }
    // First marker gets a leading newline only if there is a caput to break off.
    const prefix = i === 0 && !hasTitle ? BULLET_PREFIX : `\n${BULLET_PREFIX}`;
    inserts.set(ws, prefix);
  });

  return spliceRichText(richText, inserts, dropChars);
};

export const inlinizeListSelection = async (
  plugin: ReactRNPlugin
): Promise<void> => {
  const rem = await plugin.focus.getFocusedRem();
  if (!rem) {
    await plugin.app.toast('Place your cursor in the rem holding the list.');
    return;
  }
  const updated = inlinizeListInText(rem.text || []);
  if (!updated) {
    await plugin.app.toast('No enumerated list (1, 2, 3… / a) b) / i. ii.) detected.');
    return;
  }
  await rem.setText(updated);
};

// ---------------------------------------------------------------------------
// Command: Break inline list into children (+ snapshot for restore)
// ---------------------------------------------------------------------------

interface ListBreakSnapshot {
  originalText: RichTextInterface;
  childIds: string[];
}

const snapshotKey = (remId: string) => `listBreakSnapshot:${remId}`;

export const breakInlineListToChildren = async (
  plugin: ReactRNPlugin
): Promise<void> => {
  const rem = await plugin.focus.getFocusedRem();
  if (!rem) {
    await plugin.app.toast('Place your cursor in the inline-bulletized list rem.');
    return;
  }

  // A rem with back text is a flashcard (front/back). Breaking it into children
  // would scramble the card, so refuse rather than risk destroying it.
  if ((rem.backText || []).length > 0) {
    await plugin.app.toast(
      'This rem has back text (a flashcard) — refusing to break it into children.'
    );
    return;
  }

  const originalText = rem.text || [];
  const segments = splitOnNewlines(originalText);

  // First segment is the caput/title; the rest are items. Drop empty segments
  // and the "• " prefix from each item.
  const title = segments.length > 0 ? segments[0] : [];
  const items = segments
    .slice(1)
    .map((seg) => stripLeadingPrefix(seg, BULLET_PREFIX))
    .filter((seg) => rtPlainStr(seg).trim().length > 0);

  if (items.length === 0) {
    await plugin.app.toast(
      'No "• " item lines found. Run "Inlinize detected list" first.'
    );
    return;
  }

  // Create the children (in order), collecting ids for the restore snapshot.
  const childIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const child = await plugin.rem.createRem();
    if (!child) continue;
    await child.setText(items[i]);
    await child.setParent(rem._id, i); // position i preserves item order
    childIds.push(child._id);
  }

  // Snapshot BEFORE collapsing the parent to its title, so restore is exact.
  const snapshot: ListBreakSnapshot = { originalText, childIds };
  await plugin.storage.setSynced(snapshotKey(rem._id), snapshot);

  await rem.setText(title);
  await plugin.app.toast(
    `Broke list into ${childIds.length} child rems. Use "Restore list rem" to undo.`
  );
};

// ---------------------------------------------------------------------------
// Command: Restore list rem to its pre-break state
// ---------------------------------------------------------------------------

export const restoreListRem = async (plugin: ReactRNPlugin): Promise<void> => {
  const rem = await plugin.focus.getFocusedRem();
  if (!rem) {
    await plugin.app.toast('Place your cursor in the list rem to restore.');
    return;
  }

  const key = snapshotKey(rem._id);
  const snapshot = await plugin.storage.getSynced<ListBreakSnapshot>(key);
  if (!snapshot) {
    await plugin.app.toast('No saved snapshot for this rem — nothing to restore.');
    return;
  }

  // Delete exactly the children we created (skip any already gone / re-parented
  // away by the user).
  let removed = 0;
  for (const id of snapshot.childIds) {
    const child = (await plugin.rem.findOne(id)) as PluginRem | undefined;
    if (child && child.parent === rem._id) {
      await child.remove();
      removed++;
    }
  }

  await rem.setText(snapshot.originalText);
  await plugin.storage.setSynced(key, undefined);
  await plugin.app.toast(`Restored original list rem (removed ${removed} children).`);
};
