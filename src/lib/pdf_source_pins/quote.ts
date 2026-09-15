/**
 * Clean text a user wrote before looking it up in a source.
 *
 * Notes are often numbered or bulleted ("3. Build upon the basics"), but the
 * source renders that marker as list numbering, not text — so it never matches,
 * and a quote whose marker happens to match elsewhere ("Rule 2: Learn before
 * you memorize") would be pinned to the wrong passage. Numbers that are real
 * text ("5.1 The standard…") keep their place: the marker must be followed by
 * whitespace right after its "." or ")".
 */
export const stripListMarker = (quote: string) =>
  quote.replace(/^\s*(?:(?:\d{1,3}|[a-zA-Z])[.)]|[•\-–*])\s+/, '');

/**
 * The texts to look for, for a Rem with a front and possibly a back.
 *
 * The plugin cannot tell which side of a Rem is being edited, and a card's two
 * sides are often one passage split in two ("The drag coefficient" ↔ "has both
 * pressure and skin friction components"). So both joined, in either order, are
 * tried as well as each side alone; the caller keeps the best match.
 */
export function quoteCandidates(front: string, back: string): string[] {
  const f = stripListMarker(front).trim();
  const b = stripListMarker(back).trim();
  const list = f && b ? [`${f} ${b}`, `${b} ${f}`, f, b] : [f || b];
  return [...new Set(list.filter(Boolean))];
}

/**
 * Index of the best match — the candidate that matched the most of its OWN
 * words, the higher score breaking a tie — or -1 when nothing was found.
 *
 * Not the widest span of source words: a fuzzy match may stretch over unrelated
 * text to reach a few words that happen to recur further down ("manobra teste de
 * RPM mínimo" in the next sentence), and counting that span would let a wrong
 * candidate beat the right one.
 */
export function broadestMatch(results: { found: boolean; matched?: number; score?: number }[]): number {
  let best = -1;
  results.forEach((r, k) => {
    if (!r.found) return;
    if (best === -1) {
      best = k;
      return;
    }
    const current = results[best];
    const words = r.matched ?? 0;
    const bestWords = current.matched ?? 0;
    if (words > bestWords || (words === bestWords && (r.score ?? 0) > (current.score ?? 0))) best = k;
  });
  return best;
}
