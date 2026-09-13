import { ReactRNPlugin } from '@remnote/plugin-sdk';
import {
  bandColorPercentile,
  buildHighlightBandCSS,
  buildPriorityBandCSS,
  computeBandPercentiles,
  logBandColorMapping,
} from './priority_bands';
import { percentileToHslColor } from './utils';
import {
  queueCounterId,
  scrollToHighlightId,
  // collapseTopBarId, // Disabled: feature not working
  hideIncEverythingId,
  pdfHighlightBordersEnabledKey,
  pdfHighlightBordersReloadKey,
  showPriorityBandsInTablesId,
  hasImagePowerupName,
  pdfAreaHighlightPowerupName,
  showPinRingIndicatorsSettingId,
} from './consts';
import { getIESetting } from './settings';

/**
 * Whether the pdfextract/incremental marker borders are currently drawn over
 * PDF-viewer highlights. Backed by a per-device local flag; defaults to ON.
 */
export async function getPdfHighlightBordersEnabled(plugin: ReactRNPlugin): Promise<boolean> {
  const stored = await plugin.storage.getLocal<boolean>(pdfHighlightBordersEnabledKey);
  return stored ?? true;
}

/**
 * "Peek" toggle: flip the marker-border flag. Persists the value in local storage
 * and bumps a session key so the index widget's plugin.track re-registers the CSS
 * (registerCSS is index-only, and this may run in the highlight-toolbar iframe).
 * Returns the new enabled state. Shared by the toggle command and toolbar button.
 */
export async function togglePdfHighlightBorders(plugin: ReactRNPlugin): Promise<boolean> {
  const next = !(await getPdfHighlightBordersEnabled(plugin));
  await plugin.storage.setLocal(pdfHighlightBordersEnabledKey, next);
  await plugin.storage.setSession(pdfHighlightBordersReloadKey, Date.now());
  return next;
}

/**
 * Registers CSS to display the incremental rem counter next to the flashcard counter.
 *
 * @param plugin Plugin instance
 * @param count Number of due incremental rems to display
 */
export function registerQueueCounter(plugin: ReactRNPlugin, count: number): void {
  const css = `
    .rn-queue__card-counter {
      /*visibility: hidden;*/
    }

    .light .rn-queue__card-counter:after {
      content: ' + ${count}';
    }

    .dark .rn-queue__card-counter:after {
      content: ' + ${count}';
    }
  `.trim();

  plugin.app.registerCSS(queueCounterId, css);
  console.log(`QUEUE ENTER: Queue counter updated to show ${count} due IncRems`);
}

export async function registerPluginHidingCSS(plugin: ReactRNPlugin) {

  const css = `
      /* Hide cardPriority Slots - Priority, Priority Source and Last Updated   */
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-property~="priority"],
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-container-property~="priority"],
      [data-rem-property~="priority"]:has(.rem-powerup-icon),
      [data-rem-container-property~="priority"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-property~="priority-source"],
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-container-property~="priority-source"],
      [data-rem-property~="priority-source"]:has(.rem-powerup-icon),
      [data-rem-container-property~="priority-source"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-property~="last-updated"],
      .rn-queue:has([data-rem-tags~="cardpriority" i]) [data-rem-container-property~="last-updated"],
      [data-rem-property~="last-updated"]:has(.rem-powerup-icon),
      [data-rem-container-property~="last-updated"]:has(.rem-powerup-icon),

      /* Hide Incremental Slots - Created and History */
      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-property~="created"],
      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-container-property~="created"],
      [data-rem-property~="created"]:has(.rem-powerup-icon),
      [data-rem-container-property~="created"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-property~="history"],
      .rn-queue:has([data-rem-tags~="incremental" i]) [data-rem-container-property~="history"],
      [data-rem-property~="history"]:has(.rem-powerup-icon),
      [data-rem-container-property~="history"]:has(.rem-powerup-icon),

      /* Hide Dismissed Slots */
      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-property~="dismissed-history"],
      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-container-property~="dismissed-history"],
      [data-rem-property~="dismissed-history"]:has(.rem-powerup-icon),
      [data-rem-container-property~="dismissed-history"]:has(.rem-powerup-icon),

      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-property~="dismissed-date"],
      .rn-queue:has([data-rem-tags~="dismissed" i]) [data-rem-container-property~="dismissed-date"],
      [data-rem-property~="dismissed-date"]:has(.rem-powerup-icon),
      [data-rem-container-property~="dismissed-date"]:has(.rem-powerup-icon) {
        display: none !important; 
      }
  `;

  await plugin.app.registerCSS('hide-plugin-properties-globally', css);

}

// Register CSS for PDF Highlight coloring based on tags
// This replaces the old manual color setting logic
export async function registerPdfHighlightCSS(plugin: ReactRNPlugin) {
  // "Peek" toggle: when disabled, the PDF-viewer marker borders are omitted so the
  // highlights read cleanly (original background only). Editor styling is unaffected.
  const bordersEnabled = await getPdfHighlightBordersEnabled(plugin);
  const pdfextractMarkers = bordersEnabled
    ? `border-bottom: 1.5px dashed #1565a8 !important;
      border-right: 3px solid #73a5cd !important;`
    : '';
  const incrementalMarkers = bordersEnabled
    ? `border-bottom: 1.5px dashed #15803d !important;
      border-right: 3px solid #4baf70 !important;`
    : '';
  // Same scale as the side-panel badges above: a PDF marker's colour comes from
  // the IncRem extracted from that highlight.
  const { inc: incPercentiles } = await computeBandPercentiles(plugin);
  const incColorForBand = (band: number) =>
    percentileToHslColor(bandColorPercentile(incPercentiles, band));
  await logBandColorMapping(plugin, 'pdf marker tint (inc scale)', incPercentiles, incColorForBand);
  const highlightBandCSS = buildHighlightBandCSS(incColorForBand);
  const css = `
    /* PDF viewer: keep the highlight's ORIGINAL background and distinguish the tag
       with (a) a dashed underline and (b) a thin left bar. The underline gets
       covered by the next line's background between lines, so it's only a reliable
       marker at a block's bottom edge; the left bar is the dependable block marker
       — with box-decoration-break: clone it draws on every wrapped line, forming a
       vertical rule down the left edge regardless of what follows the extract.
       This base (unscoped) rule reaches both the PDF viewer and the editor; the
       editor is overridden below to keep its coloured background (no bar/underline).
       The border declarations are gated by the "peek" toggle (bordersEnabled). */
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] {
      ${pdfextractMarkers}
      padding-bottom: 2.7px;
      padding-left: 4px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    /* High-contrast text selection inside pdfextract highlights */
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"] ::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] ::selection,
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"]::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"]::selection {
      background-color: #0b2e6b !important;
      color: #ffffff !important;
    }
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] {
      ${incrementalMarkers}
      padding-bottom: 2.7px;
      padding-left: 4px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    /* High-contrast text selection inside incremental highlights */
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"] ::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] ::selection,
    [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"]::selection,
    [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"]::selection {
      background-color: #0b4a2e !important;
      color: #ffffff !important;
    }

    /* Editor: keep the coloured-background look (no underline). Overrides the
       dashed-underline base rules above. The dark-mode editor rules below only
       swap the background, so this border-bottom:none carries into dark mode too. */
    .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] {
      background-color: #8ad0f3 !important;
      border-bottom: none !important;
      border-right: none !important;
      padding-left: 0 !important;
    }
    .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] {
      background-color: #75f8b2 !important;
      border-bottom: none !important;
      border-right: none !important;
      padding-left: 0 !important;
    }

    /* Dark mode: darken highlight backgrounds so light text stays readable.
       Scoped to .rn-editor only. In the PDF viewer the highlight keeps its original
       background (see the base rules above) and is distinguished by the dashed
       underline instead, so no dark-mode background handling is needed there. */
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"],
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] {
      background-color: #1e496b !important;
    }
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"],
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] {
      background-color: #1a5c3a !important;
    }
    /* Dark mode (editor): lighten the selection so it stands out on the darkened
       background. The PDF viewer keeps the light-mode selection (navy/white). */
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"] ::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"] ::selection,
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="pdfextract"]::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="pdfextract"]::selection {
      background-color: #7cc4f5 !important;
      color: #06203f !important;
    }
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"] ::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"] ::selection,
    .dark .rn-editor [data-rem-tags~="pdf-highlight"][data-rem-tags~="incremental"]::selection,
    .dark .rn-editor [data-rem-tags~="html-highlight"][data-rem-tags~="incremental"]::selection {
      background-color: #6ee7a8 !important;
      color: #05381f !important;
    }

    [data-rem-tags~="pdfextract"] .hierarchy-editor__tag-bar__tag {
      font-size: 0px;
    }
    [data-rem-tags~="pdfextract"] .hierarchy-editor__tag-bar__tag:before {
      font-size: 12px;
      content: '✂️';
    }

    /* Tint the extract marker with the priority band of the IncRem extracted
       from this highlight, so importance is visible while re-reading the PDF.
       Emitted here, after the base rules above, because those set the border
       with !important and ordering between registerCSS calls is not guaranteed.
       Gated on the same "peek" toggle: with borders off there is nothing to tint. */
    ${bordersEnabled ? highlightBandCSS.markerColors : ''}
  `;

  await plugin.app.registerCSS('pdf-inc-highlight-styling', css);
}

/**
 * Badges on extracted highlights, shown wherever the highlight rem renders —
 * most usefully the Highlights side panel. Separate from the marker tint above,
 * which has to live inside the PDF stylesheet for ordering reasons.
 */
export async function registerHighlightBandBadgeCSS(plugin: ReactRNPlugin) {
  // Highlights are badged with the priority of the IncRem extracted from them,
  // so they rank on the IncRem scale.
  const { inc } = await computeBandPercentiles(plugin);
  const colorForBand = (band: number) => percentileToHslColor(bandColorPercentile(inc, band));
  await logBandColorMapping(plugin, 'highlight side-panel badges (inc scale)', inc, colorForBand);
  const { badges } = buildHighlightBandCSS(colorForBand);
  await plugin.app.registerCSS('highlight-priority-band-badges', badges);
}

/**
 * Table-cell badges. Registered here rather than in registerPluginSettings so it
 * can be re-run when the band→percentile mapping changes; the setting is still
 * what gates it.
 */
export async function registerTableBandBadgeCSS(plugin: ReactRNPlugin) {
  const enabled = await getIESetting(plugin, showPriorityBandsInTablesId);
  // Both scales are emitted; the stylesheet picks per rem from the `incremental`
  // / `cardpriority` tags the rem already carries, so a table mixing IncRems and
  // flashcards colours each on the scale its own Priority Editor uses.
  const percentiles = enabled
    ? await computeBandPercentiles(plugin)
    : { inc: null, card: null };
  const incColor = (band: number) => percentileToHslColor(bandColorPercentile(percentiles.inc, band));
  const cardColor = (band: number) =>
    percentileToHslColor(bandColorPercentile(percentiles.card, band));
  if (enabled) {
    await logBandColorMapping(plugin, 'table badges (inc scale)', percentiles.inc, incColor);
    await logBandColorMapping(plugin, 'table badges (card scale)', percentiles.card, cardColor);
  }
  await plugin.app.registerCSS(
    showPriorityBandsInTablesId,
    enabled ? buildPriorityBandCSS({ inc: incColor, card: cardColor }) : ''
  );
}

export async function registerIgnoreTagCSS(plugin: ReactRNPlugin) {
  const css = `
    /* Shrink and dim rems tagged with #ignore so they read as archived snippets */
    [data-rem-container-tags~="ignore"] .rem-text * {
      font-size: 0.85rem !important;
    }
    [data-rem-container-tags~="ignore"] .rem-text:not(:focus-within):not(:hover) * {
      opacity: 0.88;
    }

    /* Hide the #ignore tag chip in the editor tag bar to declutter */
    [data-rem-tags~="ignore"] .hierarchy-editor__tag-bar__tag {
      display: none;
    }
  `;
  await plugin.app.registerCSS('ignore-tag-styling', css);
}

/**
 * Hides the HasImage tag chip.
 *
 * The tag exists so RemNote's document Filter has something to match on; seeing
 * it in the outline is pure noise, and it would appear on a great many rems.
 *
 * Matched by the pill's own `data-test` (RemNote stamps every applied-powerup
 * pill with `Applied Powerup Pill <Name>`), not by "any chip on a hasimage rem".
 * The broad form — the shape HIDE_DISMISSED_TAG_CSS uses — would also wipe the
 * user's real tags off every rem holding an image.
 */
export async function registerHasImageCSS(plugin: ReactRNPlugin) {
  const slug = hasImagePowerupName.toLowerCase();
  const css = `
    [data-test="Applied Powerup Pill ${hasImagePowerupName}"].hierarchy-editor__tag-bar__tag {
      display: none;
    }

    /* RemNote renders a second, duplicate pill inside the Tag Bar when a rem has
       a single tag, and that one carries no attribute naming its powerup. Match
       it via the rem's own slug plus .rem-powerup-icon (the ⚡, present on powerup
       pills and never on a plain user tag) — same approach as registerTagBadgeCSS. */
    [data-rem-tags~="${slug}" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon) {
      display: none;
    }

    /* PdfAreaHighlight is the same kind of bookkeeping and is hidden the same way. */
    [data-test="Applied Powerup Pill ${pdfAreaHighlightPowerupName}"].hierarchy-editor__tag-bar__tag {
      display: none;
    }
    [data-rem-tags~="${pdfAreaHighlightPowerupName.toLowerCase()}" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon) {
      display: none;
    }
  `;
  await plugin.app.registerCSS('has-image-tag-hide', css);
}

/**
 * Rings the reference pins that lead to a Rem holding an image.
 *
 * Two attributes on RemNote's reference container make this possible, and both
 * are needed:
 *   - `data-rem-reference-pin="true"` — set from the rich-text element's `pin`
 *     flag, and the only thing separating a pin from an ordinary reference.
 *   - `data-rem-tags` — which on a reference container describes the **referenced**
 *     Rem, not the host. So `~="hasimage"` reads as *"this pin points at a Rem
 *     that holds an image"*.
 *
 * Scoping matters here: keying on the pin attribute alone rings every pin in the
 * knowledge base, which says nothing. Paired with the tag it becomes a real
 * signal while reading — this link leads to a figure — and it appears only after
 * the Tag Rems With Images command has run (see registerHasImageCSS).
 *
 * **Accent-coloured, not achromatic.** The first draft used the neutral hairline
 * token on the theory that hue is spoken for — bands own the red→green ramp,
 * `#pdfextract` is blue, `#incremental` is green. In practice a grey 1px outline
 * around an 18px icon in running text was invisible until hovered, which is no
 * marker at all. The accent is safe here because this ring cannot be confused
 * with any of those: it is an outline on an icon, never a background fill or a
 * left border, and it appears on nothing but pins. Borrowing RemNote's own
 * interactive accent also reads correctly — the same colour the app uses for
 * links and selection, on something that *is* a navigation target.
 *
 * Opacity is deliberately NOT reduced. The ring marks a pin as more interesting
 * than its neighbours; dimming it below the un-ringed pins around it would say
 * the opposite.
 *
 * No background fill: a pin can sit inside a highlighted extract, and a fill
 * would paint over the highlight's own colour. Both colours come from RemNote's
 * `--rn-clr-border-*` tokens, so the ring follows light and dark mode without a
 * `.dark` branch.
 */
export async function registerPinReferenceCSS(plugin: ReactRNPlugin) {
  // Off by default. The rings only say anything once "Tag Rems With Images" has
  // run, so drawing them unasked would put a marker on every pin in a knowledge
  // base that has no idea what it means.
  if (!(await getIESetting(plugin, showPinRingIndicatorsSettingId))) {
    // Not merely "emit nothing": the highlight stylesheet draws a band-coloured
    // border and padding on any element carrying a highlight's tags, and a
    // reference container carries the REFERENCED rem's tags — so a pin to a
    // banded highlight is marked whether or not this feature is on. That leak
    // predates the rings and is what the user is opting into here, so switching
    // the setting off has to clear it too, or "off" would still show a box.
    //
    // Scoped to pins alone: a full [[reference]] to the same highlight keeps its
    // marker, where the padding was designed for a passage of running text.
    await plugin.app.registerCSS(
      'pin-reference-styling',
      `
    /*
       SPECIFICITY, not just !important. The band marker rules in
       buildHighlightBandCSS match three attribute selectors — 0,3,0 — and carry
       !important of their own, so a 0,2,0 rule loses however loudly it shouts.
       Four qualifiers (0,4,0) settle it outright, which also makes the result
       independent of stylesheet order — and ordering between separate
       registerCSS calls is not guaranteed. Every attribute used here is present
       on a pin container: data-test, data-rem-reference-id, data-rem-tags and
       data-rem-reference-pin itself.
    */
    [data-test="Rem Reference Container"][data-rem-reference-pin="true"][data-rem-reference-id][data-rem-tags],
    .rem-reference-container[data-test="Rem Reference Container"][data-rem-reference-pin="true"][data-rem-reference-id] {
      border: none !important;
      padding: 0 !important;
    }
  `
    );
    return;
  }

  const slug = hasImagePowerupName.toLowerCase();
  const areaSlug = pdfAreaHighlightPowerupName.toLowerCase();
  const css = `
    /* A pin's ring says where it leads:
         blue           — a Rem holding an image (a figure in your own notes)
         yellow         — a TEXT highlight on a PDF page: the source passage
         purple         — a TEXT highlight in an HTML source: a saved web
                          article or a PDF's Text Reader view
         yellow + blue  — a PDF AREA highlight: a clipped figure from the source

       All three are SOLID, which keeps them clear of the priority-band marker's
       dotted/dashed vocabulary.

       Drawn as a BORDER, sharing the box with that marker rather than nesting
       outside it. A reference container carries the REFERENCED rem's tags, so on
       a pin to a banded highlight the band rules in registerPdfHighlightCSS set
       border-bottom and border-right on this very element, with !important. That
       is not a conflict to avoid but a division of labour: their declarations
       win on the two edges they name, ours hold the other two, and the result is
       ONE box reading half band-colour, half ring-colour. An outline was tried
       instead and is worse — it adds a second concentric box around an already
       marked pin, which on an extracted highlight (the common case in this
       plugin's flow) is pure clutter. */
    [data-rem-reference-pin="true"][data-rem-tags~="${slug}" i],
    [data-rem-reference-pin="true"][data-rem-tags~="${areaSlug}" i],
    [data-rem-reference-pin="true"][data-rem-tags~="pdf-highlight" i]:not([data-rem-tags~="${areaSlug}" i]),
    [data-rem-reference-pin="true"][data-rem-tags~="html-highlight" i]:not([data-rem-tags~="${areaSlug}" i]) {
      border: 1.5px solid var(--rn-clr-border-accent, #3B82F6);
      border-radius: 4px;
      padding: 0 1px;
      margin: 0 1px;
      /* Centre the box on the line instead of standing it on the baseline.

         RemNote sizes the pin glyph relative to the font (~1.22em) while pinning
         line-height at 24px, so in a 20px Rem the icon is ALREADY 24.5px — over
         the line before any ring is drawn. The 1.5px border takes the box to
         27.5px, and with vertical-align: baseline every one of those 3.5px
         overflows UPWARD, into the line above.

         Middle splits the same overflow evenly above and below, roughly halving
         what any one line sees. It does not shrink the box: only an inset
         box-shadow could do that, and that would cost the per-edge colours the
         area-highlight ring and the band edge-sharing both depend on. Measured
         at 16px the box is 22.5px and fits the line with room to spare, which is
         why this only ever showed up in larger Rems. */
      vertical-align: middle;
      transition: border-color 120ms ease;
    }

    /* Keep the box square when a priority band is also drawn on it.

       registerPdfHighlightCSS (and the band tint built on it) style a highlight
       as a passage of running text: padding-bottom 2.7px, padding-left 4px and a
       3px right bar, so the marker clears the descenders and reads down a wrapped
       paragraph. A reference container inherits those declarations along with the
       tags, and on an 18px pin the result is a box that is lopsided and visibly
       larger than the plain pins beside it.

       Only the SIZE is reset — the band's colour and its dashed/dotted style
       carry the information and are left alone.


       SPECIFICITY, not just !important. The band marker rules in
       buildHighlightBandCSS match three attribute selectors — 0,3,0 — and carry
       !important of their own, so a 0,2,0 rule loses however loudly it shouts.
       Four qualifiers (0,4,0) settle it outright, which also makes the result
       independent of stylesheet order — and ordering between separate
       registerCSS calls is not guaranteed. Every attribute used here is present
       on a pin container: data-test, data-rem-reference-id, data-rem-tags and
       data-rem-reference-pin itself. */
    [data-test="Rem Reference Container"][data-rem-reference-pin="true"][data-rem-reference-id][data-rem-tags~="pdf-highlight" i],
    [data-test="Rem Reference Container"][data-rem-reference-pin="true"][data-rem-reference-id][data-rem-tags~="html-highlight" i],
    .rem-reference-container[data-test="Rem Reference Container"][data-rem-reference-pin="true"][data-rem-tags~="pdf-highlight" i],
    .rem-reference-container[data-test="Rem Reference Container"][data-rem-reference-pin="true"][data-rem-tags~="html-highlight" i] {
      padding: 0 1px !important;
      border-right-width: 1.5px !important;
      border-bottom-width: 1.5px !important;
    }

    /* Hover and edit-mode on the blue state: step up to the selected-border
       token. RemNote already paints its own light-accent background on a hovered
       reference, so the ring only has to stay legible on top of it. */
    [data-rem-reference-pin="true"][data-rem-tags~="${slug}" i]:hover,
    .rem-text:focus-within [data-rem-reference-pin="true"][data-rem-tags~="${slug}" i] {
      border-color: var(--rn-clr-border-selected, #1d4ed8);
    }

    /* TEXT highlights — the pin opens the source passage. Yellow for a PDF
       page, purple for an HTML source: a saved web article or a PDF's Text
       Reader view. The ring is what tells apart the two pins Pin Source Quote
       adds for one passage (one per view), so the highlights share one colour. */
    [data-rem-reference-pin="true"][data-rem-tags~="pdf-highlight" i]:not([data-rem-tags~="${areaSlug}" i]) {
      border-color: #eab308;
    }
    [data-rem-reference-pin="true"][data-rem-tags~="html-highlight" i]:not([data-rem-tags~="${areaSlug}" i]) {
      border-color: #a855f7;
    }

    /* AREA highlights are both things at once — a highlight (yellow) AND an
       image (blue) — so they carry both colours, per edge.

       The order matters: TOP is yellow and LEFT is blue precisely because those
       are the two edges the band marker leaves alone, so both colours survive on
       a banded pin. Right and bottom repeat the pair for an unbanded one, giving
       an alternating box rather than a half-empty ring.

       Per-edge colours rather than a linear-gradient: a gradient needs
       border-image, which paints all four edges from one image and is NOT
       overridden by the band's border-color, so it would erase the band marker
       on bottom/right — losing exactly the edge-sharing this design rests on.
       It also drops border-radius, and a yellow-to-blue blend across ~1.5px of
       line reads as muddy green at this size. */
    [data-rem-reference-pin="true"][data-rem-tags~="${areaSlug}" i] {
      border-color: #eab308 #3B82F6 #eab308 #3B82F6;
    }

    /* Hover and edit-mode brighten each text-highlight colour in its own hue —
       this has to gain contrast in dark mode too, where a deeper shade would sink
       into the background. Keep the two apart: sharing one bright colour here
       turned the purple (HTML source) ring yellow whenever its Rem was edited. */
    [data-rem-reference-pin="true"][data-rem-tags~="pdf-highlight" i]:not([data-rem-tags~="${areaSlug}" i]):hover,
    .rem-text:focus-within [data-rem-reference-pin="true"][data-rem-tags~="pdf-highlight" i]:not([data-rem-tags~="${areaSlug}" i]) {
      border-color: #facc15;
    }
    [data-rem-reference-pin="true"][data-rem-tags~="html-highlight" i]:not([data-rem-tags~="${areaSlug}" i]):hover,
    .rem-text:focus-within [data-rem-reference-pin="true"][data-rem-tags~="html-highlight" i]:not([data-rem-tags~="${areaSlug}" i]) {
      border-color: #c084fc;
    }
    [data-rem-reference-pin="true"][data-rem-tags~="${areaSlug}" i]:hover,
    .rem-text:focus-within [data-rem-reference-pin="true"][data-rem-tags~="${areaSlug}" i] {
      border-color: #facc15 #60a5fa #facc15 #60a5fa;
    }
  `;
  await plugin.app.registerCSS('pin-reference-styling', css);
}

export async function registerTagBadgeCSS(plugin: ReactRNPlugin) {
  const css = `
    /* Replace the "Incremental" powerup label with a 🔍 badge in the editor.

       A RemNote change made an applied powerup render in TWO places that both
       carry the .hierarchy-editor__tag-bar__tag class the old rule keyed on:
         1. the "Applied Powerup Pill" (a sibling of the Tag Bar), and
         2. a legacy pill inside [data-test="Tag Bar"] (shown when the rem has a
            single tag).
       The old broad selector matched both — and, because its only qualifier was
       "any rem tagged incremental", it also matched the pills of OTHER powerups
       (e.g. CardPriority) on the same rem. So the badge appeared twice and
       leaked onto unrelated powerups.

       Fix: badge only the Incremental Applied Powerup Pill (matched by its stable
       data-test), and hide the redundant Tag-Bar duplicate below. The extra
       .hierarchy-editor__tag-bar__tag qualifier keeps this off the document
       header's Applied Powerups Menu button, which reuses the same data-test but
       is a <button> whose inline font-size our reset can't override. */
    [data-test="Applied Powerup Pill Incremental"].hierarchy-editor__tag-bar__tag {
      font-size: 0px;
    }
    [data-test="Applied Powerup Pill Incremental"].hierarchy-editor__tag-bar__tag:before {
      font-size: 12px;
      content: '🔍';
    }

    /* Hide the powerup pill RemNote now duplicates inside the editor Tag Bar
       (only visible for single-tag rems); the Applied Powerup Pill above is the
       canonical representation. Scoped to our powerups via the rem's own
       data-rem-tags so we never hide an unrelated tag, and gated on
       .rem-powerup-icon (the ⚡) which marks a powerup pill, never a plain user
       tag. */
    [data-rem-tags~="incremental" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon),
    [data-rem-tags~="cardpriority" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon),
    [data-rem-tags~="dismissed" i] [data-test="Tag Bar"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon) {
      display: none;
    }
  `;
  await plugin.app.registerCSS('tag-badge-styling', css);
}

export async function registerClozeExtractCSS(plugin: ReactRNPlugin) {
  const css = `
    /* Badge: violet ↑ pill before the bullet */
    [data-queue-rem-tags~="clozeextract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container,
    [data-queue-rem-tags~="cloze-extract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container {
      position: relative;
    }
    [data-queue-rem-tags~="clozeextract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container::before,
    [data-queue-rem-tags~="cloze-extract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container::before {
      content: '↑';
      background: #7c3aed;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      line-height: 1.4;
      padding: 1px 5px;
      border-radius: 3px;
      margin-right: 4px;
    }
    /* Tooltip shown when hovering the bullet container */
    [data-queue-rem-tags~="clozeextract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container:hover::after,
    [data-queue-rem-tags~="cloze-extract"].rn-queue-rem:not(.rem-bullet__document) .rn-bullet-container:hover::after {
      content: 'Cloze child — created from a parent rem via Create Cloze Deletion';
      position: absolute;
      top: -30px;
      left: 0;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      font-size: 11px;
      font-weight: 400;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      z-index: 100;
      pointer-events: none;
    }

    /* Editor: Make cloze-extract rems less conspicuous */
    .rn-editor [data-rem-tags~="clozeextract"] .rem-text,
    .rn-editor [data-rem-tags~="cloze-extract"] .rem-text {
      opacity: 0.5;
      filter: grayscale(40%);
      zoom: 0.8;
      transition: all 0.2s ease-in-out;
    }

    /* Reveal full opacity when focused/hovered for readability */
    .rn-editor [data-rem-tags~="clozeextract"]:focus-within .rem-text,
    .rn-editor [data-rem-tags~="cloze-extract"]:focus-within .rem-text,
    .rn-editor [data-rem-tags~="clozeextract"]:hover .rem-text,
    .rn-editor [data-rem-tags~="cloze-extract"]:hover .rem-text {
      opacity: 1;
      filter: grayscale(0%);
    }

    /* Dark-mode contrast fix for the "already-clozed" source mark that Create
       Cloze Deletion applies to the parent text (yellow highlight + red font,
       see commands.ts). Bright-yellow-bg/red-text is low-contrast on a dark
       canvas; swap to deep amber + light coral. The yellow+red class pair is
       unique to our mark, so native RemNote clozes are left untouched. Covers
       both the editor leaf container and the queue linear-editor item. */
    .dark .has-highlight-color.highlight-color--yellow.text-color--red {
      background-color: #4a3700 !important;
      color: #ff9e80 !important;
    }
  `;
  await plugin.app.registerCSS('cloze-extract-badge', css);
}

/**
 * Clears all queue-specific UI elements (menu items and CSS).
 * Called when the user navigates away from the flashcards view.
 *
 * @param plugin Plugin instance
 */
export function clearQueueUI(plugin: ReactRNPlugin): void {
  plugin.app.unregisterMenuItem(scrollToHighlightId);
  // plugin.app.registerCSS(collapseTopBarId, ''); // Disabled: feature not working
  plugin.app.registerCSS(queueCounterId, '');
  plugin.app.registerCSS(hideIncEverythingId, '');
}


/**
 * Fill colour for a "% processed / % done" bar.
 *
 * The old rule turned green only at EXACTLY 100%, so a bucket at 99.8% — every
 * card but one — was painted the same amber as a bucket at 50%. Nobody reads a
 * bar that precisely; the colour is meant to answer "am I on top of this?", and
 * at 99.8% the answer is yes. Green therefore starts at 95%, with a lime step
 * so "nearly there" still reads differently from "done".
 *
 * Shared by the Weighted Shield breakdown and the Card Priority × Memory
 * Analytics table so the same percentage never gets two different colours.
 */
export function doneBarColor(pct: number): string {
  if (!Number.isFinite(pct)) return '#ef4444';
  if (pct >= 95) return '#22c55e';
  if (pct >= 80) return '#84cc16';
  if (pct >= 50) return '#eab308';
  return '#ef4444';
}

/** A bar this close to full should have both ends rounded. */
export const isBarFull = (pct: number): boolean => pct >= 99.5;
