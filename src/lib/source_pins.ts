// Shared "source pin" detection for the extract flows.
//
// An extract's rich text ends with a reference pin to its parent
// (`{i:'q', _id: parent._id, pin: true}`). When the parent is itself an
// extract of a PDF/web highlight, it also carries a pin to that highlight —
// the bridge back to the original source. Sub-extracts must inherit that
// bridge, otherwise the chain to the source is lost one level down.
//
// The criterion is deliberately keyed on the *built-in highlight powerups*,
// not on this plugin's own `pdfextract` tag: the tag only marks highlights
// this plugin extracted through the "Create IncRem" toolbar, so keying on it
// alone would miss highlights made incremental by any other route (native
// RemNote extraction, Opt+X straight on the highlight, a hand-built pin). The
// tag is kept as an OR-fallback for highlights whose powerup lookup fails.
//
// Do NOT add the Incremental powerup to this list. Every extract pins its own
// parent, and that parent is Incremental by construction — a sub-extract would
// then copy the grandparent pin, the next one the great-grandparent, and each
// extract would accumulate the whole ancestry chain. The highlight powerups
// work precisely because they mark a *terminal source*, not a link in the
// extract chain.

import {
  BuiltInPowerupCodes,
  PluginRem,
  ReactRNPlugin,
  RichTextInterface,
} from '@remnote/plugin-sdk';

/**
 * Powerups that mark a rem as a terminal reading source worth bridging to.
 * Extend with document-level codes (`BuiltInPowerupCodes.PDF`,
 * `BuiltInPowerupCodes.Website`) if pins to a whole document should be carried
 * too — the rest of this module needs no change.
 */
export const SOURCE_PIN_POWERUPS: BuiltInPowerupCodes[] = [
  BuiltInPowerupCodes.PDFHighlight,
  BuiltInPowerupCodes.HTMLHighlight,
];

/**
 * Per-call resolver. Caches the `pdfextract` tag lookup and the per-rem
 * verdicts so scanning both `text` and `backText` (which often pin the same
 * highlight) costs one probe per distinct referenced rem, not one per node.
 */
export const createSourcePinResolver = (plugin: ReactRNPlugin) => {
  const verdicts = new Map<string, Promise<boolean>>();
  let tagRemPromise: Promise<PluginRem | undefined> | undefined;

  const getPdfExtractTagRem = () => {
    if (!tagRemPromise) {
      tagRemPromise = plugin.rem
        .findByName(['pdfextract'], null)
        .then((r) => r || undefined)
        .catch(() => undefined); // tag rem may not exist
    }
    return tagRemPromise;
  };

  const probe = async (remId: string): Promise<boolean> => {
    const referencedRem = await plugin.rem.findOne(remId);
    if (!referencedRem) return false;

    for (const code of SOURCE_PIN_POWERUPS) {
      if (await referencedRem.hasPowerup(code)) return true;
    }

    const tagRem = await getPdfExtractTagRem();
    if (!tagRem) return false;
    const tags = await referencedRem.getTagRems();
    return tags.some((t) => t._id === tagRem._id);
  };

  return {
    /** True when a rem-reference node points at a bridgeable reading source. */
    isSourceRef: (remId: string): Promise<boolean> => {
      let verdict = verdicts.get(remId);
      if (!verdict) {
        verdict = probe(remId).catch(() => false);
        verdicts.set(remId, verdict);
      }
      return verdict;
    },
  };
};

type SourcePinResolver = ReturnType<typeof createSourcePinResolver>;

/** A rem-reference rich text node (`i:'q'`) with a resolvable target. */
const isRemRefNode = (item: any): item is { i: 'q'; _id: string } =>
  typeof item === 'object' && item !== null && item.i === 'q' && !!item._id;

/**
 * Collect every source pin carried by the given rich texts, in order, one per
 * distinct referenced rem. Pass a rem's `text` and `backText` together so a
 * pin living on the back of a card is found too.
 */
export const collectSourcePins = async (
  plugin: ReactRNPlugin,
  richTexts: (RichTextInterface | undefined)[],
  resolver: SourcePinResolver = createSourcePinResolver(plugin)
): Promise<any[]> => {
  const pins: any[] = [];
  const seen = new Set<string>();
  for (const richText of richTexts) {
    for (const item of richText || []) {
      if (!isRemRefNode(item) || seen.has(item._id)) continue;
      if (await resolver.isSourceRef(item._id)) {
        seen.add(item._id);
        pins.push({ ...(item as any), pin: true });
      }
    }
  }
  return pins;
};

/**
 * Split a rich text into its source pins and everything else, preserving the
 * order of both. Unlike {@link collectSourcePins} this keeps duplicates — the
 * caller is rewriting the text, so dropping a node silently would lose it.
 */
export const partitionSourcePins = async (
  plugin: ReactRNPlugin,
  richText: RichTextInterface,
  resolver: SourcePinResolver = createSourcePinResolver(plugin)
): Promise<{ pins: any[]; rest: RichTextInterface }> => {
  const pins: any[] = [];
  const rest: any[] = [];
  for (const item of richText) {
    if (isRemRefNode(item) && (await resolver.isSourceRef(item._id))) {
      pins.push({ ...(item as any), pin: true });
    } else {
      rest.push(item);
    }
  }
  return { pins, rest };
};
