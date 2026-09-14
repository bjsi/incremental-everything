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
