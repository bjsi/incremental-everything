// "Bulletize Inline Selected Text" — toggle a "• " prefix on each line within a
// single rem.
//
// Motivation: RemNote soft line breaks (Shift+Enter) keep multiple visual lines
// inside ONE rem. PDF highlights often flatten real bullet lists into such
// soft-wrapped text, dropping the bullets. Re-adding "• " by hand at every line
// start is tedious, especially when prepping a highlight to become an IncRem.
//
// This command inserts/removes "• " at the start of each selected line. It is a
// toggle: if every non-empty selected line already starts with "• ", they are
// all stripped; otherwise the prefix is added to the lines that lack it.
//
// Line-break representation (confirmed via a rem snapshot): RemNote serializes
// an in-rem soft line break (Shift+Enter) as a literal "\n" character inside the
// rich-text string / `i:'m'` text nodes — e.g. a rem reads as the single node
//   ['a. Engine characteristics\n\n• Type of engine...\nRPM indicators...']
// so all line math below operates on the plain-char projection of the rich text.

import {
  ReactRNPlugin,
  RichTextInterface,
  SelectionType,
} from '@remnote/plugin-sdk';

export const BULLET_PREFIX = '• ';

// Plain-text projection of rich text. Text nodes (raw strings and i:'m')
// contribute their characters; every other node (references, images, latex…)
// contributes nothing. This gives stable "plain-char" offsets that we use for
// all line math, matching the approach in lib/extract.ts.
const rtPlainStr = (rt: RichTextInterface): string =>
  rt
    .map((item: any) =>
      typeof item === 'string' ? item : item?.i === 'm' ? item.text || '' : ''
    )
    .join('');

// Apply insertions/deletions of the bullet prefix, expressed in plain-char
// offsets, to a rich-text array — preserving all formatting and non-text nodes.
//
//   inserts: offsets at which "• " should be inserted (as a plain node).
//   deletes: offsets at which an existing "• " (2 plain chars) should be removed.
const applyBulletEdits = (
  richText: RichTextInterface,
  inserts: Set<number>,
  deletes: Set<number>
): RichTextInterface => {
  // Expand each delete offset into the two individual char offsets to drop.
  const dropChars = new Set<number>();
  for (const d of deletes) {
    dropChars.add(d);
    dropChars.add(d + 1);
  }

  const result: any[] = [];
  let idx = 0; // running plain-char offset

  const pushSlice = (node: any, isString: boolean, text: string) => {
    if (!text) return;
    result.push(isString ? text : { ...node, text });
  };

  for (const item of richText) {
    const isString = typeof item === 'string';
    const isTextNode = isString || (item as any)?.i === 'm';

    if (!isTextNode) {
      // Non-text node has zero plain width. Honor an insertion landing exactly
      // at this boundary, then pass the node through untouched.
      if (inserts.has(idx)) result.push(BULLET_PREFIX);
      result.push(item);
      continue;
    }

    const node: any = isString ? { i: 'm', text: item } : item;
    const text: string = node.text || '';
    let buf = '';

    for (let k = 0; k < text.length; k++) {
      if (inserts.has(idx)) {
        // Flush the accumulated (formatted) slice, then drop the bullet in as a
        // standalone plain node so it never inherits highlight/color formatting.
        pushSlice(node, isString, buf);
        buf = '';
        result.push(BULLET_PREFIX);
      }
      if (!dropChars.has(idx)) {
        buf += text[k];
      }
      idx++;
    }
    pushSlice(node, isString, buf);
  }

  // Insertion at the very end of the section.
  if (inserts.has(idx)) result.push(BULLET_PREFIX);

  return result;
};

// Given a section's rich text and a plain-char range the user touched, toggle
// bullets on every line that range intersects. Returns the new rich text, or
// null if nothing changed.
export const toggleBulletsInRange = (
  richText: RichTextInterface,
  rangeStart: number,
  rangeEnd: number
): RichTextInterface | null => {
  const S = rtPlainStr(richText);
  if (S.length === 0) return null;

  // Expand the start back to the beginning of its line so a partial selection
  // still bulletizes whole lines.
  const firstLineStart = S.lastIndexOf('\n', Math.max(0, rangeStart - 1)) + 1;
  const effEnd = Math.max(rangeEnd, firstLineStart);

  // Collect the start offset of every line the range touches.
  const lineStarts: number[] = [firstLineStart];
  for (let p = firstLineStart; p < effEnd; p++) {
    if (S[p] === '\n') lineStarts.push(p + 1);
  }

  // Examine each line; skip empty lines entirely.
  type LineInfo = { start: number; bulleted: boolean };
  const lines: LineInfo[] = [];
  for (const start of lineStarts) {
    let end = S.indexOf('\n', start);
    if (end === -1) end = S.length;
    const content = S.substring(start, end);
    if (content.length === 0) continue; // empty line — nothing to bullet
    lines.push({ start, bulleted: content.startsWith(BULLET_PREFIX) });
  }

  if (lines.length === 0) return null;

  const inserts = new Set<number>();
  const deletes = new Set<number>();

  const allBulleted = lines.every((l) => l.bulleted);
  if (allBulleted) {
    // Toggle OFF — strip the prefix from every line.
    for (const l of lines) deletes.add(l.start);
  } else {
    // Toggle ON — add the prefix only to lines that lack it.
    for (const l of lines) if (!l.bulleted) inserts.add(l.start);
  }

  return applyBulletEdits(richText, inserts, deletes);
};

// Locate which section (front text vs back text) of a rem contains the live
// text selection, returning the section's rich text plus the selection's
// plain-char range within it.
const resolveSection = (
  rem: { text?: RichTextInterface; backText?: RichTextInterface },
  selectionRichText: RichTextInterface
): {
  isBack: boolean;
  sectionText: RichTextInterface;
  start: number;
  end: number;
} | null => {
  const frontText = rem.text || [];
  const backText = rem.backText || [];
  const frontStr = rtPlainStr(frontText);
  const backStr = rtPlainStr(backText);
  const selStr = rtPlainStr(selectionRichText);

  if (selStr.length === 0) return null;

  const posInFront = frontStr.indexOf(selStr);
  const posInBack = backText.length > 0 ? backStr.indexOf(selStr) : -1;

  if (posInFront >= 0) {
    return {
      isBack: false,
      sectionText: frontText,
      start: posInFront,
      end: posInFront + selStr.length,
    };
  }
  if (posInBack >= 0) {
    return {
      isBack: true,
      sectionText: backText,
      start: posInBack,
      end: posInBack + selStr.length,
    };
  }
  return null;
};

// Command entry point. Toggles bullets on the selected lines of the focused rem.
// With a collapsed cursor (no selection), it toggles bullets across the rem's
// entire front text — a convenient "bulletize this whole rem" gesture.
export const bulletizeSelection = async (plugin: ReactRNPlugin): Promise<void> => {
  const selection = await plugin.editor.getSelection();

  // Case 1: a real (non-collapsed) text selection — operate on touched lines.
  if (
    selection &&
    selection.type === SelectionType.Text &&
    selection.range.start !== selection.range.end
  ) {
    const rem = await plugin.rem.findOne(selection.remId);
    if (!rem) return;

    const section = resolveSection(rem, selection.richText as RichTextInterface);
    if (!section) {
      await plugin.app.toast('Could not locate the selected text in this rem.');
      return;
    }

    const updated = toggleBulletsInRange(
      section.sectionText,
      section.start,
      section.end
    );
    if (!updated) return;

    if (section.isBack) {
      await rem.setBackText(updated);
    } else {
      await rem.setText(updated);
    }
    return;
  }

  // Case 2: collapsed cursor or rem selection — bulletize the whole front text.
  const rem =
    (selection && selection.type === SelectionType.Text
      ? await plugin.rem.findOne(selection.remId)
      : undefined) || (await plugin.focus.getFocusedRem());
  if (!rem) {
    await plugin.app.toast('Place your cursor in a rem to bulletize its lines.');
    return;
  }

  const frontText = rem.text || [];
  const updated = toggleBulletsInRange(
    frontText,
    0,
    rtPlainStr(frontText).length
  );
  if (!updated) return;
  await rem.setText(updated);
};
