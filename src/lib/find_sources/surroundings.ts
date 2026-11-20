/**
 * Where a note sits, for Find Sources, Check Statement and Ask Your Sources: one walk up
 * its ancestors (no SDK runtime import, so it runs under node:test).
 */
import type { PluginRem } from '@remnote/plugin-sdk';
import { REM_TYPE_DESCRIPTOR } from '../descriptor_chain';

/** Rems above a note given as its OUTLINE PATH (Ask Your Sources, Check Statement). */
const OUTLINE_LEVELS = 3;
/** Longer than this, an outline Rem is a note of its own, not a heading: left out. */
const OUTLINE_MAX_CHARS = 150;
/** Ancestors walked for the provider's `ancestors` (the books the notes are from). */
const MAX_ANCESTORS = 40;

/**
 * What a run sends about where a note sits, from one walk up its ancestors:
 * - `ancestors`: their ids, for the provider;
 * - `context`: a descriptor's chain (lib/descriptor_chain) as one line, "Concept ›
 *   descriptor above", for the search and for Claude: the note means nothing without it;
 * - `outline` (with `withOutline`): up to OUTLINE_LEVELS Rems above that, up to and with
 *   the document, outermost first, for Claude only (in a search query they would pull in
 *   passages about the whole topic).
 */
export async function noteSurroundings(
  rem: PluginRem,
  textOf: (rem: PluginRem) => Promise<string>,
  withOutline: boolean
): Promise<{ ancestors: string[]; context?: string; outline?: string }> {
  const above: PluginRem[] = [];
  let parent = await rem.getParentRem();
  while (parent && above.length < MAX_ANCESTORS) {
    above.push(parent);
    parent = await parent.getParentRem();
  }
  const ancestors = above.map((r) => r._id);
  const line = async (rems: PluginRem[]) =>
    (await Promise.all(rems.map((r) => textOf(r).catch(() => ''))))
      .map((t) => t.trim())
      .filter((t) => t && t.length <= OUTLINE_MAX_CHARS)
      .reverse()
      .join(' \u203a ') || undefined;

  // A descriptor: its descriptor ancestors, and the first one that is not (its concept).
  let chainLength = 0;
  if ((rem.type as number) === REM_TYPE_DESCRIPTOR) {
    while (chainLength < above.length && (above[chainLength].type as number) === REM_TYPE_DESCRIPTOR) chainLength++;
    chainLength = Math.min(chainLength + 1, above.length);
  }
  const context = chainLength
    ? (await Promise.all(above.slice(0, chainLength).map((r) => textOf(r).catch(() => ''))))
        .map((t) => t.trim())
        .filter(Boolean)
        .reverse()
        .join(' \u203a ') || undefined
    : undefined;
  if (!withOutline) return { ancestors, context };

  const path: PluginRem[] = [];
  for (const r of above.slice(chainLength)) {
    if (path.length >= OUTLINE_LEVELS) break;
    path.push(r);
    if (await r.isDocument().catch(() => false)) break;
  }
  return { ancestors, context, outline: await line(path) };
}
