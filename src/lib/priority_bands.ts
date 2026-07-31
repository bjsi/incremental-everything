// Priority bands — the only way to show a priority inside a RemNote table cell.
//
// RemNote renders NO plugin widget inside table cells: the per-node plugin mount
// is gated on `nodeType === REM` and the RightSideOfEditor slot never renders for
// TABLE_CELL nodes (verified against the desktop bundle and by a DOM probe —
// table cells 0/4 got the widget, plain rems 4/4). So `priority_editor` cannot
// follow the user into a table.
//
// What IS available in a cell, even in the static fast-render pass that tables
// use before you hover them, is the `data-rem-tags` attribute on the `.rem` span.
// It carries powerup slugs. So we mirror each rem's priority into one of ten
// band powerups and let CSS draw the badge from the tag — the same mechanism
// `SHOW_LEFT_BORDER_CSS` in register/settings.ts already relies on.
//
// The cost of that mechanism is granularity: a tag is a boolean, so a badge can
// show which band of ten a rem sits in, not its exact number.

import { BuiltInPowerupCodes, PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import {
  allCardPriorityInfoKey,
  allIncrementalRemKey,
  dismissedHistorySlotCode,
  dismissedPowerupCode,
  powerupCode,
  prioritySlotCode,
} from './consts';
// Import from card_priority/types, a leaf module of plain constants, NOT from
// card_priority/index. index calls syncPriorityBand, so importing it back here
// would form a cycle — and breaking that cycle with a dynamic import() is not an
// option: any chunk it emits is evaluated by the RemNote index sandbox as a
// classic script and dies on `import.meta` (see the note atop register/tracker.ts).
import { CARD_PRIORITY_CODE, PRIORITY_SLOT } from './card_priority/types';

export const BAND_COUNT = 10;

/**
 * How often the bulk operations log progress to the console. Separate from the
 * write batch size below: batching controls how many writes are in flight,
 * this only controls how chatty the console is.
 */
export const PROGRESS_LOG_INTERVAL = 250;

/**
 * Shared by the powerup name, the data-rem-tags slug and the tag-bar hide rule —
 * all three must agree or the badge silently stops matching.
 */
export const BAND_POWERUP_NAME_PREFIX = 'PriorityBand';

/** Powerup code for a band index (0 = priorities 0–9, 9 = 90–100). */
export function bandPowerupCode(band: number): string {
  return `priorityBand${band}`;
}

/**
 * Powerup NAME for a band. RemNote derives the `data-rem-tags` slug from the
 * name (lowercased, spaces stripped) — `CardPriority` becomes `cardpriority` —
 * so the name, not the code, is what the CSS selector has to match.
 */
export function bandPowerupName(band: number): string {
  return `${BAND_POWERUP_NAME_PREFIX}${band}`;
}

/** The slug CSS must select on. Keep in lockstep with bandPowerupName. */
export function bandTagSlug(band: number): string {
  return bandPowerupName(band).toLowerCase();
}

/** Band index for a priority, clamped so 100 lands in the top band with 90–99. */
export function bandForPriority(priority: number): number {
  return Math.max(0, Math.min(BAND_COUNT - 1, Math.floor(priority / 10)));
}

/** Human label for a band, e.g. 7 -> "70s". */
export function bandLabel(band: number): string {
  return `${band * 10}s`;
}

/**
 * Which priority a badge should show for this rem, or null if the rem should
 * carry no badge at all.
 *
 * Deliberately mirrors the routing used for bulk edits in tracker.ts: an IncRem
 * shows its Incremental priority, a rem with a card priority shows that. A rem
 * that is neither gets nothing — resolving card priority for those would fall
 * back to the default setting and end up tagging every rem in the knowledge base.
 *
 * Both values are read straight from their slots rather than through
 * getCardPriorityValue(). That avoids importing card_priority/index (see the
 * cycle note on the imports), and the slot is already the resolved number: an
 * inherited priority is written into it with source='inherited' by
 * setCardPriority, which is also what the queue reads. The one case it does not
 * cover is a rem with cards that has never had a priority written at all, which
 * correspondingly has nothing to show — and which the backfill command likewise
 * does not enumerate, since it walks the CardPriority powerup's tagged rems.
 */
export async function effectivePriorityForBadge(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<number | null> {
  return (await readBadgePriority(plugin, rem)).priority;
}

/** effectivePriorityForBadge plus the IncRem flag it already had to look up. */
async function readBadgePriority(
  _plugin: RNPlugin,
  rem: PluginRem
): Promise<{ priority: number | null; isInc: boolean }> {
  const [isInc, hasCardPowerup] = await Promise.all([
    rem.hasPowerup(powerupCode),
    rem.hasPowerup(CARD_PRIORITY_CODE),
  ]);

  const raw = isInc
    ? await rem.getPowerupProperty(powerupCode, prioritySlotCode)
    : hasCardPowerup
    ? await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT)
    : null;

  if (!raw) return { priority: null, isInc };
  const value = parseInt(raw, 10);
  return { priority: isNaN(value) ? null : value, isInc };
}

/**
 * Mirrors an IncRem's band onto the PDF/HTML highlight it was extracted from.
 *
 * An extract records its origin as a pinned Rem reference in its own text
 * (see createRemUnderParent in lib/highlightActions.ts), so the highlight is
 * reachable from the IncRem without storing anything new — and when the pin has
 * been moved down onto a direct child, from there instead. Giving the highlight
 * the same band lets CSS badge it in the Highlights side panel and tint its
 * marker in the PDF itself — priority information that until now lived only on
 * the extract, invisible while re-reading the source document.
 *
 * The highlight carries no priority of its own, so it is never a target of
 * syncPriorityBand: its band arrives only from here, and only from the IncRem
 * that references it.
 */
/**
 * Rem ids referenced from a rem's own rich text.
 *
 * Parses the text in memory instead of calling remsBeingReferenced(), which is a
 * round trip per rem — unaffordable across a 50k-rem sweep, and the reason the
 * push was removed from the bulk path. Reference items carry `i: 'q'` and the
 * target's `_id`; the pin flag is deliberately ignored, since a hand-made link
 * to a highlight is an ordinary reference.
 */
export function referencedRemIdsFromText(rem: PluginRem): string[] {
  const text = (rem as any).text;
  if (!Array.isArray(text)) return [];
  const ids: string[] = [];
  for (const item of text) {
    if (item && typeof item === 'object' && item.i === 'q' && typeof item._id === 'string') {
      ids.push(item._id);
    }
  }
  return ids;
}

async function applyBandToHighlightRefs(
  rem: PluginRem,
  desired: number | null
): Promise<{ found: number; wrote: number }> {
  let refs: PluginRem[] = [];
  try {
    refs = (await rem.remsBeingReferenced()) as PluginRem[];
  } catch (err) {
    console.error('[PriorityBands] remsBeingReferenced failed for', rem._id, err);
    return { found: 0, wrote: 0 };
  }

  let found = 0;
  let wrote = 0;
  for (const ref of refs) {
    const isHighlight =
      (await ref.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) ||
      (await ref.hasPowerup(BuiltInPowerupCodes.HTMLHighlight));
    if (!isHighlight) continue;
    found++;
    try {
      if (await applyBand(ref, desired)) wrote++;
    } catch (err) {
      console.error('[PriorityBands] highlight band sync failed for', ref._id, err);
    }
  }
  return { found, wrote };
}

async function syncHighlightBands(
  rem: PluginRem,
  desired: number | null
): Promise<number> {
  const own = await applyBandToHighlightRefs(rem, desired);
  if (own.found > 0) return own.wrote;

  // Fallback: the pin lives on a direct child, not on the extract itself.
  //
  // A common workflow turns an extract into a CONCEPT — the paragraph is retitled
  // with the concept it defines (Cmd+Opt+C), its prose is broken out into child
  // rems, and the pin reference moves down with the prose. Keeping the pin on the
  // concept would pollute search results and would repeat as clutter everywhere
  // the concept is referenced, so it deliberately does not live there. Without
  // this fallback such highlights would never be badged.
  //
  // Only reached when the rem references no highlight of its own, so the ordinary
  // extract — which does — never pays for the child walk. First level only:
  // deeper descendants belong to other extracts, not to this one.
  let wrote = 0;
  try {
    for (const child of (await rem.getChildrenRem()) as PluginRem[]) {
      wrote += (await applyBandToHighlightRefs(child, desired)).wrote;
    }
  } catch (err) {
    console.error('[PriorityBands] child highlight scan failed for', rem._id, err);
  }
  return wrote;
}

/** Reconciles a rem to exactly one band tag (or none). Returns true if it wrote. */
async function applyBand(rem: PluginRem, desired: number | null): Promise<boolean> {
  const present: number[] = [];
  for (let band = 0; band < BAND_COUNT; band++) {
    if (await rem.hasPowerup(bandPowerupCode(band))) present.push(band);
  }

  // Already correct — and exactly one tag, so no stale bands to clean up.
  if (present.length === 1 && present[0] === desired) return false;
  if (!present.length && desired === null) return false;

  let wrote = false;
  for (const band of present) {
    if (band === desired) continue;
    await rem.removePowerup(bandPowerupCode(band));
    wrote = true;
  }
  if (desired !== null && !present.includes(desired)) {
    await rem.addPowerup(bandPowerupCode(desired));
    wrote = true;
  }
  return wrote;
}

// --- Eligibility -----------------------------------------------------------
//
// A band only earns its keep if the rem can actually appear as a table row, and
// a RemNote table is a view over rems sharing a tag, with that tag's slots as
// columns. So a rem is eligible when it carries at least one NON-powerup tag
// that defines slots. Without this filter every card and extract in the KB gets
// a synced powerup write — tens of thousands in a large KB, nearly all of them
// for rems that will never be seen in a table.
//
// Known limitation: a table built from a document/portal view rather than a tag
// gets no badges, because there is no tag to key on.

const tagHasSlotsCache = new Map<string, boolean>();

/** Tag definitions change rarely; call this before a full refresh to re-read them. */
export function clearBandEligibilityCache(): void {
  tagHasSlotsCache.clear();
}

async function tagDefinesSlots(tag: PluginRem): Promise<boolean> {
  const cached = tagHasSlotsCache.get(tag._id);
  if (cached !== undefined) return cached;

  let has = false;
  try {
    for (const child of await tag.getChildrenRem()) {
      if (await child.isSlot()) {
        has = true;
        break;
      }
    }
  } catch (err) {
    console.error('[PriorityBands] slot check failed for tag', tag._id, err);
  }
  tagHasSlotsCache.set(tag._id, has);
  return has;
}

/**
 * Whether this rem could ever be rendered as a table row — the only place the
 * badge is visible. Cheap by design: one getTagRems() plus cached per-tag
 * lookups, so it can gate the expensive powerup reads and writes below.
 */
export async function isBandEligible(rem: PluginRem): Promise<boolean> {
  let tags: PluginRem[] = [];
  try {
    tags = (await rem.getTagRems()) as PluginRem[];
  } catch (err) {
    console.error('[PriorityBands] getTagRems failed for', rem._id, err);
    return false;
  }

  for (const tag of tags) {
    // Our own powerups (Incremental, CardPriority, the bands themselves) are not
    // evidence of anything: they sit on nearly every rem the plugin touches.
    if (await tag.isPowerup()) continue;
    if (await tagDefinesSlots(tag)) return true;
  }
  return false;
}

/**
 * Brings a rem's band tag in line with its current priority.
 *
 * Returns true when something was written. The no-op check matters more than it
 * looks: every write here modifies the rem and re-fires GlobalRemChanged, which
 * is exactly how autoAssignCardPriority once produced an infinite ~1s loop (see
 * the note in lib/card_priority/index.ts). Reconciling to the desired band and
 * writing nothing when it already matches keeps this safe to call from the same
 * paths that write priorities.
 */
export type BandSyncResult = {
  /** The rem's own table badge changed. */
  self: boolean;
  /** How many source highlights had their badge changed by propagation. */
  highlights: number;
  /** Whether the rem could carry a table badge at all (see isBandEligible). */
  eligible: boolean;
};

export async function syncPriorityBand(
  plugin: RNPlugin,
  rem: PluginRem,
  options?: {
    /**
     * Skip pushing this rem's band onto its source highlights.
     *
     * Set by the bulk refresh, whose highlight phase (syncAllHighlightBands)
     * recomputes every highlight from all of its links anyway — so the push is
     * not merely redundant there, it is the expensive part: a reference lookup,
     * and sometimes a child walk, for every IncRem in the knowledge base.
     * Live edits leave it on, since that is what updates a highlight the instant
     * you set a priority rather than at the next manual refresh.
     */
    skipHighlights?: boolean;
  }
): Promise<BandSyncResult> {
  const { priority, isInc } = await readBadgePriority(plugin, rem);
  const desired = priority === null ? null : bandForPriority(priority);

  // Extracts are rarely tagged with a slotted tag, so this has to run BEFORE the
  // table gate below or a PDF extract would never reach its source highlight.
  // Restricted to IncRems: card-priority writes cascade across whole subtrees and
  // must not pay for a reference lookup each.
  const highlights =
    isInc && !options?.skipHighlights ? await syncHighlightBands(rem, desired) : 0;

  // Gate: returns for the large majority of rems in a big KB, before the ten
  // hasPowerup reads in applyBand, let alone a write.
  if (!(await isBandEligible(rem))) {
    return { self: false, highlights, eligible: false };
  }

  return { self: await applyBand(rem, desired), highlights, eligible: true };
}

/**
 * Strips every band tag from the knowledge base.
 *
 * Maintenance counterpart to removeAllCardPriorityTags, and safe in a way that
 * one is not: bands hold no data of their own — they are a derived mirror of a
 * priority that still lives in the Incremental / CardPriority slots. So this is
 * fully reversible by running "Refresh Priority Badges (Tables)" afterwards.
 */
export async function removeAllPriorityBands(plugin: RNPlugin): Promise<number> {
  const confirmed = confirm(
    '⚠️ Remove All Priority Band Tags\n\n' +
    'This removes the PriorityBand0–9 tags that draw the priority badge inside table cells.\n\n' +
    'No priority data is lost: the bands are derived from the Incremental and CardPriority ' +
    'slots, which are untouched. You can rebuild them at any time with ' +
    '"Refresh Priority Badges (Tables)".\n\n' +
    'Proceed?'
  );

  if (!confirmed) {
    console.log('[PriorityBands] removal cancelled by user');
    await plugin.app.toast('Priority band cleanup cancelled');
    return 0;
  }

  console.log('[PriorityBands] Removal started');
  await plugin.app.toast('Removing priority band tags…');
  // Suppress GlobalRemChanged listener during bulk writes, as the CardPriority
  // cleanup does — this touches every banded rem in the KB.
  await plugin.storage.setSession('plugin_operation_active', true);

  try {
    // Enumerate per band and remove THAT band from THAT powerup's tagged rems.
    // Walking rems and testing all ten bands each would cost ~10 reads per rem
    // before any write; the tagged lists already tell us exactly which pairs
    // exist, which is roughly a tenth of the calls.
    const pairs: Array<{ rem: PluginRem; band: number }> = [];
    const uniqueRems = new Set<string>();
    for (let band = 0; band < BAND_COUNT; band++) {
      const powerup = await plugin.powerup.getPowerupByCode(bandPowerupCode(band));
      const tagged = (await powerup?.taggedRem()) || [];
      for (const rem of tagged) {
        pairs.push({ rem: rem as PluginRem, band });
        uniqueRems.add(rem._id);
      }
      if (tagged.length) {
        console.log(`[PriorityBands] band ${band} (${bandLabel(band)}): ${tagged.length} rems`);
      }
    }

    if (!pairs.length) {
      console.log('[PriorityBands] Removal complete — no band tags found');
      await plugin.app.toast('No priority band tags found to remove');
      return 0;
    }

    const total = pairs.length;
    console.log(`[PriorityBands] Removing ${total} band tags across ${uniqueRems.size} rems...`);
    await plugin.app.toast(`Removing ${total} band tags from ${uniqueRems.size} rems…`);

    let done = 0;
    let lastToastPct = 0;
    const batchSize = 50;

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async ({ rem, band }) => {
          try {
            await rem.removePowerup(bandPowerupCode(band));
          } catch (e) {
            console.log(`[PriorityBands] could not remove band ${band} from ${rem._id}:`, e);
          }
        })
      );

      const prev = done;
      done += batch.length;
      // Console at a fixed interval so progress is visible even when toasts are
      // throttled; toast only every 10% so a long run does not spam them.
      if (
        Math.floor(prev / PROGRESS_LOG_INTERVAL) !== Math.floor(done / PROGRESS_LOG_INTERVAL) ||
        done === total
      ) {
        console.log(`[PriorityBands] ${done}/${total} band tags removed`);
      }
      const pct = Math.floor((done / total) * 100);
      if (pct >= lastToastPct + 10 && done < total) {
        lastToastPct = pct - (pct % 10);
        await plugin.app.toast(`Band cleanup: ${lastToastPct}% (${done}/${total})`);
      }
    }

    const summary = `Priority band tags removed: ${total} tags across ${uniqueRems.size} rems.`;
    console.log(`[PriorityBands] ✅ ${summary}`);
    await plugin.app.toast(`✅ ${summary}`);
    return uniqueRems.size;
  } catch (err) {
    console.error('[PriorityBands] removal failed', err);
    await plugin.app.toast('Removing priority band tags failed — see console.');
    return 0;
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }
}

/**
 * syncPriorityBand over many rems, skipping ids that no longer resolve.
 *
 * `onProgress` fires every PROGRESS_LOG_INTERVAL rems so a KB-wide refresh can
 * report progress rather than looking hung — the cadence removeAllPriorityBands
 * also uses.
 */
export async function syncPriorityBands(
  plugin: RNPlugin,
  remIds: string[],
  onProgress?: (done: number, total: number, stats: BandSyncStats) => void,
  /**
   * Collects every rem id referenced from a prioritised rem's text. Built-in
   * powerup membership is NOT enumerable — getPowerupByCode resolves the PDF
   * Highlight powerup but its taggedRem() returns nothing — so highlights this
   * plugin never extracted from cannot be listed directly. Harvesting the links
   * while we are already walking these rems is the way to reach them, and costs
   * nothing extra: the text is already in memory.
   */
  referencedIds?: Set<string>
): Promise<BandSyncStats> {
  const stats: BandSyncStats = { changed: 0, eligible: 0, highlights: 0 };
  let done = 0;

  for (const remId of remIds) {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      if (referencedIds) {
        for (const id of referencedRemIdsFromText(rem)) referencedIds.add(id);
      }
      try {
        const result = await syncPriorityBand(plugin, rem, { skipHighlights: true });
        if (result.eligible) stats.eligible++;
        stats.highlights += result.highlights;
        // A rem counts as changed if its own badge moved OR it pushed a band onto
        // a source highlight. Counting only the former reported 0 updated across
        // a whole knowledge base while highlights were in fact being written.
        if (result.self || result.highlights > 0) stats.changed++;
      } catch (err) {
        console.error('[PriorityBands] sync failed for', remId, err);
      }
    }
    done++;
    if (onProgress && (done % PROGRESS_LOG_INTERVAL === 0 || done === remIds.length)) {
      onProgress(done, remIds.length, stats);
    }
  }
  return stats;
}

type LinkedPriority = {
  value: number;
  /** False for a Dismissed rem, which only counts when nothing live links here. */
  live: boolean;
};

/**
 * The priority a linked rem contributes to its highlight's badge, or null if it
 * carries none.
 *
 * "Live" means the rem still has an active priority — an IncRem still in the
 * queue, or a rem with a card priority. A Dismissed rem contributes its last
 * recorded priority: dismissal means the material was processed and its cards
 * made, NOT that it was unimportant, so the value stays meaningful. It is still
 * marked non-live because a highlight that some live rem links to should be
 * badged from that rem, not from a finished one.
 *
 * The dismissed value comes from the history preserved on the Dismissed powerup:
 * IncrementalRep entries record the absolute priority at review time. The
 * 'dismissed' marker entry itself carries none (see markAsDismissed), so this
 * scans backwards for the most recent entry that has one — a rem dismissed
 * before ever being reviewed therefore contributes nothing.
 */
async function linkedRemPriority(rem: PluginRem): Promise<LinkedPriority | null> {
  const [isInc, hasCard] = await Promise.all([
    rem.hasPowerup(powerupCode),
    rem.hasPowerup(CARD_PRIORITY_CODE),
  ]);

  if (isInc) {
    const raw = await rem.getPowerupProperty(powerupCode, prioritySlotCode);
    const value = raw ? parseInt(raw, 10) : NaN;
    if (!isNaN(value)) return { value, live: true };
  }
  if (hasCard) {
    const raw = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
    const value = raw ? parseInt(raw, 10) : NaN;
    if (!isNaN(value)) return { value, live: true };
  }

  if (!(await rem.hasPowerup(dismissedPowerupCode))) return null;
  try {
    const raw = await rem.getPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode);
    if (!raw) return null;
    const history = JSON.parse(raw) as Array<{ priority?: number }>;
    for (let i = history.length - 1; i >= 0; i--) {
      const value = history[i]?.priority;
      if (typeof value === 'number' && !isNaN(value)) return { value, live: false };
    }
  } catch (err) {
    console.error('[PriorityBands] dismissed history parse failed for', rem._id, err);
  }
  return null;
}

/**
 * The band a highlight should carry, from every rem that links to it.
 *
 * Reads in the REVERSE direction to syncPriorityBand: rather than each rem
 * pushing onto its highlights, a highlight pulls from everything referencing it.
 * That makes several links deterministic — the forward direction was last-writer-
 * wins, so the surviving band depended on processing order — and it is far
 * cheaper, since highlights number in the hundreds against tens of thousands of
 * rems.
 *
 * Plain average, no weighting. Dismissed rems are used only when no live rem
 * links the highlight.
 */
export async function computeHighlightBand(highlight: PluginRem): Promise<number | null> {
  let linked: PluginRem[] = [];
  try {
    linked = (await highlight.remsReferencingThis()) as PluginRem[];
  } catch (err) {
    console.error('[PriorityBands] remsReferencingThis failed for', highlight._id, err);
    return null;
  }

  const live: number[] = [];
  const dismissed: number[] = [];

  for (const rem of linked) {
    let found = await linkedRemPriority(rem);

    // Concept workflow: the pin sits on a child while the priority lives on the
    // parent concept, so a linking rem with no priority of its own defers one
    // level up. Mirrors the child fallback in syncHighlightBands.
    if (!found) {
      try {
        const parent = (await rem.getParentRem()) as PluginRem | undefined;
        if (parent) found = await linkedRemPriority(parent);
      } catch {
        /* orphaned or inaccessible parent — nothing to contribute */
      }
    }

    if (!found) continue;
    (found.live ? live : dismissed).push(found.value);
  }

  const pool = live.length ? live : dismissed;
  if (!pool.length) return null;

  const mean = pool.reduce((a, b) => a + b, 0) / pool.length;
  return bandForPriority(Math.round(mean));
}

/**
 * Reconciles every highlight's badge from the rems linking to it.
 *
 * Enumerates by the built-in PDF/HTML highlight powerups rather than by the
 * plugin's own `pdfextract` tag. That tag only marks highlights THIS plugin
 * extracted from, which would have excluded every highlight linked to flashcards
 * made by hand or before this feature existed — exactly the links whose
 * priorities are most worth surfacing while re-reading a document.
 *
 * The wider scope costs reads, not writes: a highlight with no prioritised link
 * resolves to null, and applyBand writes nothing when there is no band to remove.
 */
export async function syncAllHighlightBands(
  plugin: RNPlugin,
  onProgress?: (done: number, total: number, changed: number) => void,
  /** Ids referenced by prioritised rems; those that are highlights join the pass. */
  candidateIds?: Set<string>
): Promise<{ scanned: number; changed: number }> {
  // Enumerated from several sources and unioned by id. The powerup route is the
  // one that reaches highlights this plugin never touched; the pdfextract tag is
  // kept as a second source so extracted highlights cannot regress if the powerup
  // lookup comes back empty. Each source logs its own count, because a silent 0
  // here is indistinguishable from "nothing needed updating".
  const byId = new Map<string, PluginRem>();

  const addFrom = async (label: string, load: () => Promise<PluginRem[]>) => {
    try {
      const rems = await load();
      let added = 0;
      for (const rem of rems || []) {
        if (!byId.has(rem._id)) added++;
        byId.set(rem._id, rem);
      }
      console.log(`[PriorityBands] source "${label}": ${rems?.length ?? 0} rems (${added} new)`);
    } catch (err) {
      console.error(`[PriorityBands] source "${label}" failed`, err);
    }
  };

  for (const code of [BuiltInPowerupCodes.PDFHighlight, BuiltInPowerupCodes.HTMLHighlight]) {
    await addFrom(`powerup:${code}`, async () => {
      const powerup = await plugin.powerup.getPowerupByCode(code);
      if (!powerup) {
        console.warn(`[PriorityBands] getPowerupByCode("${code}") returned undefined`);
        return [];
      }
      return ((await powerup.taggedRem()) || []) as PluginRem[];
    });
  }

  await addFrom('tag:pdfextract', async () => {
    const tagRem = await plugin.rem.findByName(['pdfextract'], null);
    if (!tagRem) {
      console.warn('[PriorityBands] no rem named "pdfextract" found');
      return [];
    }
    return ((await tagRem.taggedRem()) || []) as PluginRem[];
  });

  if (candidateIds?.size) {
    await addFrom('referenced-in-text', async () => {
      const found: PluginRem[] = [];
      for (const id of candidateIds) {
        if (byId.has(id)) continue; // already enumerated; skip the lookup
        const rem = await plugin.rem.findOne(id);
        if (!rem) continue;
        const isHighlight =
          (await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) ||
          (await rem.hasPowerup(BuiltInPowerupCodes.HTMLHighlight));
        if (isHighlight) found.push(rem as PluginRem);
      }
      console.log(
        `[PriorityBands] resolved ${candidateIds.size} referenced ids -> ${found.length} highlights`
      );
      return found;
    });
  }

  const highlights = [...byId.values()];
  console.log(`[PriorityBands] ${highlights.length} highlights to reconcile`);

  let changed = 0;
  let done = 0;
  for (const highlight of highlights) {
    try {
      if (await applyBand(highlight, await computeHighlightBand(highlight))) changed++;
    } catch (err) {
      console.error('[PriorityBands] highlight band sync failed for', highlight._id, err);
    }
    done++;
    if (onProgress && (done % PROGRESS_LOG_INTERVAL === 0 || done === highlights.length)) {
      onProgress(done, highlights.length, changed);
    }
  }
  return { scanned: highlights.length, changed };
}

/** Below this many samples the distribution is noise; fall back to absolute. */
const MIN_PERCENTILE_SAMPLE = 20;

/**
 * Band→percentile mapping, computed SEPARATELY for the two priority populations.
 *
 * The Priority Editor ranks an IncRem against other IncRems and a card against
 * other cards — never against a pooled list — so a single blended distribution
 * still mismatched the widget it was meant to agree with. Keeping the pools
 * apart lets each badge use the scale its own UI uses.
 *
 * Either side is null when that pool is too small to rank meaningfully; callers
 * then fall back to the absolute value.
 */
export type BandSyncStats = {
  /** Rems whose own badge changed, or which updated a source highlight. */
  changed: number;
  /** Rems that can carry a table badge (tagged with a slot-defining tag). */
  eligible: number;
  /** Highlight badges written by propagation from an IncRem. */
  highlights: number;
};

export type BandPercentiles = {
  inc: number[] | null;
  card: number[] | null;
};

function percentilesFor(values: number[]): number[] | null {
  if (values.length < MIN_PERCENTILE_SAMPLE) return null;
  const sorted = [...values].sort((a, b) => a - b);

  return Array.from({ length: BAND_COUNT }, (_, band) => {
    const midpoint = band * 10 + 5;
    // Binary search for the count of priorities <= midpoint. Matches how the
    // Priority Editor ranks: share of items at or below this value.
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= midpoint) lo = mid + 1;
      else hi = mid;
    }
    return Math.round((lo / sorted.length) * 1000) / 10;
  });
}

/**
 * Samples both caches to build the mappings. CSS cannot compute, so this is
 * resolved once and baked into the generated stylesheets — necessarily a
 * snapshot, recomputed at startup and after a badge refresh.
 */
export async function computeBandPercentiles(plugin: RNPlugin): Promise<BandPercentiles> {
  const incPriorities: number[] = [];
  const cardPriorities: number[] = [];
  try {
    const [incRems, cardInfos] = await Promise.all([
      plugin.storage.getSession<Array<{ priority?: number }>>(allIncrementalRemKey),
      plugin.storage.getSession<Array<{ priority?: number }>>(allCardPriorityInfoKey),
    ]);
    for (const item of incRems || []) {
      if (typeof item?.priority === 'number' && !isNaN(item.priority)) {
        incPriorities.push(item.priority);
      }
    }
    for (const item of cardInfos || []) {
      if (typeof item?.priority === 'number' && !isNaN(item.priority)) {
        cardPriorities.push(item.priority);
      }
    }
  } catch (err) {
    console.error('[PriorityBands] percentile sampling failed', err);
    return { inc: null, card: null };
  }

  return { inc: percentilesFor(incPriorities), card: percentilesFor(cardPriorities) };
}

/**
 * The number to feed percentileToHslColor for a band. Kept here so the table
 * badges, the highlight badges and the PDF marker tint cannot drift apart.
 */
export function bandColorPercentile(percentiles: number[] | null, band: number): number {
  return percentiles ? percentiles[band] : band * 10 + 5;
}

/**
 * Badge + marker tint for PDF/HTML highlights that have been extracted.
 *
 * The highlight carries the band of the IncRem extracted from it, so the
 * priority is visible in two places it never used to be: as a pill in the
 * Highlights side panel, and as the colour of the highlight's marker in the PDF
 * itself — so a priority is legible while re-reading the source, not only from
 * the extract.
 *
 * Applies to any highlight carrying a band — see syncAllHighlightBands for why
 * that is not limited to highlights this plugin extracted from. Highlights with
 * no prioritised link carry no band and keep the neutral styling.
 *
 * `markerColors` must be emitted INSIDE registerPdfHighlightCSS's stylesheet,
 * after its base rules — those set the marker border with `!important`, and
 * ordering between separate registerCSS calls is not guaranteed.
 */
export function buildHighlightBandCSS(colorForBand: (band: number) => string): {
  badges: string;
  markerColors: string;
} {
  // Keyed on the highlight powerups themselves, NOT on the plugin's `pdfextract`
  // tag: a band is now computed for every highlight with a prioritised link,
  // including ones linked only to hand-made flashcards. Requiring pdfextract
  // would badge only what this plugin extracted from.
  const pdf = '.rem[data-rem-tags~="pdf-highlight"]';
  const html = '.rem[data-rem-tags~="html-highlight"]';

  const badgeRules = Array.from({ length: BAND_COUNT }, (_, band) => {
    const slug = bandTagSlug(band);
    return `
${pdf}[data-rem-tags~="${slug}"]::before,
${html}[data-rem-tags~="${slug}"]::before {
  content: "${bandLabel(band)}";
  background: ${colorForBand(band)};
}`;
  }).join('\n');

  // Absolutely positioned on the `.rem` span, bottom-right. Three earlier
  // placements each failed for a different reason, so they are worth recording:
  //   1. absolute inside `.rem-text` — that element is a flex container in the
  //      side panel, so the pseudo became a stretched flex item, a coloured slab
  //      over the text;
  //   2. absolute on `.rem`, top-right — hidden behind the tags chip and backlink
  //      counter, which are anchored in that corner;
  //   3. in-flow flex item after the text — visible, but it reserves horizontal
  //      width in an already narrow panel and forced the text to wrap early.
  // Absolute keeps it out of flow (no width reserved); bottom-right is the corner
  // RemNote leaves empty. `::before` rather than `::after` because on `.rem`,
  // `::after` renders past the tag bar.
  //
  // Caveat: on a single-line highlight the two corners nearly coincide, so the
  // badge can sit close to the counter.
  const badges = `
/* Priority band badges on highlights (Incremental Everything) */
${pdf}[data-rem-tags*="priorityband"],
${html}[data-rem-tags*="priorityband"] {
  position: relative;
}
${pdf}[data-rem-tags*="priorityband"]::before,
${html}[data-rem-tags*="priorityband"]::before {
  position: absolute;
  display: inline-block;
  inset: auto;
  bottom: 2px;
  right: 4px;
  width: auto;
  height: auto;
  flex: none;
  z-index: 5;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 9px;
  font-weight: 700;
  line-height: 14px;
  color: #fff;
  pointer-events: none;
  white-space: nowrap;
}
${badgeRules}
`;

  // Declares the marker as well as its colour, rather than only tinting. The base
  // rules in registerPdfHighlightCSS draw a marker for `pdfextract` and
  // `incremental` highlights only, so a highlight banded purely through a
  // flashcard link had nothing to tint. Same widths as those rules, so an
  // extracted highlight looks exactly as before apart from the colour.
  const markerColors = Array.from({ length: BAND_COUNT }, (_, band) => `
    ${pdf}[data-rem-tags~="${bandTagSlug(band)}"],
    ${html}[data-rem-tags~="${bandTagSlug(band)}"] {
      border-bottom: 1.5px dashed ${colorForBand(band)} !important;
      border-right: 3px solid ${colorForBand(band)} !important;
      padding-bottom: 2.7px;
      padding-left: 4px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }`).join('\n');

  return { badges, markerColors };
}

export function buildPriorityBandCSS(colors: {
  inc: (band: number) => string;
  card: (band: number) => string;
}): string {
  // Two colour scales, chosen per rem by the tags it already carries.
  //
  // The Priority Editor ranks an IncRem among IncRems and a card among cards, so
  // one blended scale mismatched it. A band tag does not record which population
  // its value came from — but the rem itself does: an IncRem carries
  // `incremental` and a prioritised card carries `cardpriority`, both already in
  // data-rem-tags. So the card scale is the base rule and the IncRem scale is an
  // override with one extra attribute selector, giving it higher specificity.
  //
  // The precedence matches readBadgePriority(): a rem that is BOTH an IncRem and
  // has a card priority is badged with its IncRem priority, and the override
  // colours it on the IncRem scale accordingly.
  const rules = Array.from({ length: BAND_COUNT }, (_, band) => {
    const slug = bandTagSlug(band);
    const base = `.tree-node--table-cell .rem[data-rem-tags~="${slug}"] .rem-text`;
    const incOverride = `.tree-node--table-cell .rem[data-rem-tags~="${slug}"][data-rem-tags~="incremental"] .rem-text`;
    return `
${base}::before {
  content: "${bandLabel(band)}";
  background: ${colors.card(band)};
}
${incOverride}::before {
  background: ${colors.inc(band)};
}`;
  }).join('\n');

  // ::before rather than ::after because that is the pseudo-element the corner
  // placement was actually verified with against a live table.
  return `
/* Priority band badges in table cells (Incremental Everything) */
.tree-node--table-cell .rem[data-rem-tags*="priorityband"] .rem-text {
  position: relative;
}
.tree-node--table-cell .rem[data-rem-tags*="priorityband"] .rem-text::before {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 5;
  padding: 1px 6px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  color: #fff;
  pointer-events: none;
  white-space: nowrap;
}
${rules}
`;
}

/**
 * Hides the band tags from the tag bar.
 *
 * RemNote stamps each applied-powerup pill with `data-test="Applied Powerup Pill
 * <PowerupName>"`, so a prefix match reaches exactly the ten band powerups and
 * nothing else. That precision matters: the plugin's existing HIDE_CARD_PRIORITY_CSS
 * hides EVERY chip on a matching rem, which here would have wiped the user's own
 * tags off nearly every card in the knowledge base.
 *
 * Registered unconditionally, not with the badge stylesheet — turning the badges
 * off should not make ten rows of implementation-detail chips appear.
 *
 * The inline pill variant (rendered inside rich text, marked by `rem-powerup-icon`)
 * carries no equivalent attribute, but that one only appears where a powerup is
 * explicitly referenced in text, not on every tagged rem.
 */
export const PRIORITY_BAND_TAG_HIDE_CSS = `
.hierarchy-editor__tag-bar__tag[data-test^="Applied Powerup Pill ${BAND_POWERUP_NAME_PREFIX}"] {
  display: none;
}

/* RemNote renders a tag bar chip two ways. The applied-powerup pill above is
   identifiable by name; the second, inline variant (marked by .rem-powerup-icon)
   carries NO attribute naming its powerup, and CSS cannot match on text. It
   surfaces when a band is a rem's only visible tag — with two or more, RemNote
   collapses them into a "2 tags" chip and the band never shows.
   So this hides powerup pills on band-carrying rems specifically. The ✂️
   pdfextract chip is unaffected: pdfextract is an ordinary tag rem, not a
   powerup, so it has no .rem-powerup-icon. */
.rem[data-rem-tags*="priorityband"] .hierarchy-editor__tag-bar__tag:has(.rem-powerup-icon) {
  display: none;
}
`;
