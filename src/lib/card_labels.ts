// lib/card_labels.ts
//
// Naming the individual cards of one Rem.
//
// A Rem with eight cards shows eight histories, and "Cloze Card", "Cloze Card",
// "Cloze Card"… tells the reader nothing about which is which. RemNote's own
// metadata panel solves it by putting the distinguishing text in parentheses
// after the type — `Cloze (the pressure differences)`, `Forward Card` — and
// this produces the same labels so the plugin's history popup reads like the
// panel next to it.
//
// The distinguishing text per card type:
//   forward  — the Rem's FRONT (what the card asks)
//   backward — the Rem's BACK  (what the card asks)
//   cloze    — the words inside that specific cloze, found by matching the
//              card's `type.clozeId` against the `cId` markup in the rich text.
//              This is the only one that needs a lookup: `collectClozeTexts` in
//              card_analytics_export returns the texts but not which id each
//              belongs to, and without the id a Rem's five clozes are again
//              indistinguishable.
//
// WHY IT GOES THROUGH resolveRemTextSegments
//
// Rich text is not just text. A clozed span can take in a REM REFERENCE, and
// reading `node.text` off the elements — which is all `collectClozeTexts` does —
// sees nothing there, because a reference element (`{ i: 'q', _id }`) carries an
// id and no text. So the reference silently contributes nothing: a cloze over
// "a [Carena]" came out labelled `Cloze (a)`, keeping the article and dropping
// the word that identified it, and a cloze over a reference ALONE came out
// empty. The partial case is the worse of the two — it looks like a label
// rather than a failure.
//
// lib/richTextRemRefs already solves exactly this for breadcrumbs and list rows:
// it resolves each reference to the referenced Rem's text in `[ ]`, and collapses
// a reference PIN to a 📌 rather than expanding the (often enormous) rem behind
// it. Both conventions are reused verbatim here, so a card label reads the same
// way as the breadcrumb above it.

import { RNPlugin } from '@remnote/plugin-sdk';
import { RemTextSegment, resolveRemTextSegments } from './richTextRemRefs';

/** Longest identifier text kept inline; the full text stays in the tooltip. */
export const CARD_LABEL_MAX_CHARS = 70;

export interface CardLabel {
  /** 'forward' | 'backward' | 'cloze' | whatever the card reports. */
  kind: string;
  /** Type name as shown: "Forward Card", "Cloze". */
  typeName: string;
  /** The distinguishing text, already trimmed. Empty when there is none. */
  identifier: string;
  /** typeName plus the identifier in parentheses — the one-line label. */
  full: string;
}

/**
 * Render resolved segments the way a breadcrumb does: references already carry
 * their `[ ]`, and a pin becomes a 📌 instead of the rem it points at.
 */
function segmentsToString(segments: RemTextSegment[]): string {
  return segments.map((s) => (s.kind === 'pin' ? '📌' : s.text)).join('');
}

/**
 * Cloze id → the text inside it, references and pins resolved.
 *
 * A cloze split across several elements (partly bolded, or text plus a
 * reference) contributes each fragment, joined in document order.
 */
export function clozeTextsFromSegments(segments: RemTextSegment[]): Map<string, string> {
  const parts = new Map<string, string[]>();
  for (const segment of segments) {
    if (!segment.cId) continue;
    const piece = segment.kind === 'pin' ? '📌' : segment.text;
    if (!piece) continue;
    const bucket = parts.get(segment.cId);
    if (bucket) bucket.push(piece);
    else parts.set(segment.cId, [piece]);
  }
  const out = new Map<string, string>();
  for (const [id, fragments] of parts) out.set(id, fragments.join('').trim());
  return out;
}

function titleCase(kind: string): string {
  if (!kind) return 'Card';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function truncateLabel(text: string, max = CARD_LABEL_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Labels for every card of one Rem, keyed by card id.
 *
 * The Rem's front and back are each resolved ONCE into segments, and both the
 * direction labels and the cloze map are derived from those — reference
 * resolution costs a `findOne` per reference, so resolving separately for the
 * two purposes would double it for no gain.
 */
export async function buildCardLabels(
  plugin: RNPlugin,
  rem: { text?: any; backText?: any } | null,
  cards: { _id: string; type?: any }[]
): Promise<Map<string, CardLabel>> {
  const [frontSegments, backSegments] = await Promise.all([
    rem?.text ? resolveRemTextSegments(plugin, rem.text) : Promise.resolve([]),
    rem?.backText ? resolveRemTextSegments(plugin, rem.backText) : Promise.resolve([]),
  ]);

  const frontText = segmentsToString(frontSegments);
  const backText = segmentsToString(backSegments);

  const clozeTexts = clozeTextsFromSegments(frontSegments);
  // Clozes can live on the back of a Rem too (RemNote's panel labels them the
  // same way), so fold the back's markup in as well.
  for (const [id, text] of clozeTextsFromSegments(backSegments)) {
    if (!clozeTexts.has(id)) clozeTexts.set(id, text);
  }

  const out = new Map<string, CardLabel>();
  for (const card of cards) {
    const type = card.type;
    const isCloze = !!type && typeof type === 'object' && 'clozeId' in type;

    if (isCloze) {
      const clozeId = String((type as any).clozeId);
      const identifier = truncateLabel(clozeTexts.get(clozeId) ?? '');
      out.set(card._id, {
        kind: 'cloze',
        typeName: 'Cloze',
        identifier,
        // A cloze whose markup was edited away has no text left to show; fall
        // back to a short id so the row is still distinguishable from its
        // siblings rather than collapsing into a bare "Cloze".
        full: identifier ? `Cloze (${identifier})` : `Cloze (#${clozeId.slice(0, 6)})`,
      });
      continue;
    }

    const kind = typeof type === 'string' ? type : 'card';
    const identifier = truncateLabel(kind === 'backward' ? backText : frontText);
    const typeName = `${titleCase(kind)} Card`;
    out.set(card._id, {
      kind,
      typeName,
      identifier,
      full: identifier ? `${typeName} (${identifier})` : typeName,
    });
  }
  return out;
}
