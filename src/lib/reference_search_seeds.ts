/**
 * Find Rem (widgets/reference_finder.tsx): which searches to ask RemNote for, given
 * what the user typed. The picker then keeps only the Rems that contain every typed
 * word, so a seed only has to bring the right Rem into the pool.
 *
 * How RemNote's search retrieves (SQLite FTS5 over `remsContents`):
 *   • it splits the query on every non-letter/digit character, keeps the tokens longer
 *     than two characters and ORs them as prefix matches. That pool ("every Rem with a
 *     word starting with sea, margin or becomes") is truncated to the top-ranked
 *     thousand, and a Rem matching ALL the words ranks no higher than one matching a
 *     single word, so with common words the wanted Rem rarely survives the cut;
 *   • the one branch that isolates a Rem is an exact adjacent-phrase match on the
 *     whole query (prefix on its last word), when it has at least 2 tokens.
 *
 * So a multi-word query only works when the words sit side by side in the INDEXED
 * text, and the indexed text is not the text on screen: a Rem reference is not
 * indexed where it sits but appended at the END of the Rem's text. "Ships … sea loads
 * … expected. [sea margin] becomes useless …" is indexed as
 * "ships … expected . becomes useless … minimum . sea margin", so the phrase
 * "sea margin becomes" never matches, and its words alone ("becomes" 738 Rems,
 * "sea" 3,513) drown it. Hence the adjacent PAIRS of the query as extra phrase seeds:
 * "sea margin" matches 3 Rems in a 357,745-row index, this one among them. A pair
 * breaks only where the reference does, and a pair across a reference boundary is
 * still one of several.
 *
 * Figures: FTS prefix-matches only the LAST word of a phrase, so "fig 6.4" does not
 * reach "Figure 6.4" and vice-versa; phrases are asked for in both spellings.
 */

/**
 * Treat "Figure", "Fig" and "Fig." (any capitalisation, after folding) as the same
 * word. `\bfig\b` won't touch the "fig" inside "figure" (no word boundary between "g"
 * and "u"), so already-canonical text is left alone.
 */
export const canonFig = (s: string) => s.replace(/\bfig\b\.?/g, 'figure');

/** The opposite spelling, only for seeding the search (see above). */
export const shortFig = (s: string) => s.replace(/\bfigure\b/g, 'fig');

/** A bounded number of backend searches per (debounced) keystroke. */
export const MAX_SEEDS = 8;
/** Pair phrases kept from a long query; the rest of the budget goes to single words. */
const MAX_PAIRS = 4;

const spellings = (s: string) => [s, canonFig(s), shortFig(s)];
const hasLongToken = (s: string) => s.split(/[^\p{L}\p{N}]+/u).some((t) => t.length > 2);

/**
 * The searches for normalized query `q` (trimmed, lower-case), most selective first:
 * the whole query as a phrase, then adjacent word pairs, then single words (longest
 * first, since the most distinctive word reaches a Rem buried under common ones).
 */
export function searchSeeds(q: string): string[] {
  const words = q.split(/\s+/).filter(Boolean);
  const tokens = words.filter((t) => t.length >= 2);
  const singles = Array.from(
    new Set(tokens.flatMap((t) => (/^fig\.?$/.test(t) ? [t, 'figure'] : t === 'figure' ? [t, 'fig'] : [t])))
  ).sort((a, b) => b.length - a.length);

  // With two words the pair IS the phrase. A pair RemNote cannot run as a phrase
  // (no token over two characters) only repeats a single-word search.
  const pairs =
    words.length < 3
      ? []
      : words
          .slice(1)
          .map((w, i) => `${words[i]} ${w}`)
          .filter(hasLongToken)
          .map((p, i) => ({ p, i }))
          .sort((a, b) => b.p.length - a.p.length) // the longest pairs are the most distinctive…
          .slice(0, MAX_PAIRS)
          .sort((a, b) => a.i - b.i) // …kept in the order they were typed
          .flatMap(({ p }) => spellings(p));

  return Array.from(new Set([...spellings(q), ...pairs, ...singles])).slice(0, MAX_SEEDS);
}
