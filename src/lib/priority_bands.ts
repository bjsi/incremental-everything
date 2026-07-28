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

import { PluginRem, RNPlugin } from '@remnote/plugin-sdk';
import { powerupCode, prioritySlotCode } from './consts';
// Import from card_priority/types, a leaf module of plain constants, NOT from
// card_priority/index. index calls syncPriorityBand, so importing it back here
// would form a cycle — and breaking that cycle with a dynamic import() is not an
// option: any chunk it emits is evaluated by the RemNote index sandbox as a
// classic script and dies on `import.meta` (see the note atop register/tracker.ts).
import { CARD_PRIORITY_CODE, PRIORITY_SLOT } from './card_priority/types';

export const BAND_COUNT = 10;

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
  _plugin: RNPlugin,
  rem: PluginRem
): Promise<number | null> {
  const [isInc, hasCardPowerup] = await Promise.all([
    rem.hasPowerup(powerupCode),
    rem.hasPowerup(CARD_PRIORITY_CODE),
  ]);

  const raw = isInc
    ? await rem.getPowerupProperty(powerupCode, prioritySlotCode)
    : hasCardPowerup
    ? await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT)
    : null;

  if (!raw) return null;
  const value = parseInt(raw, 10);
  return isNaN(value) ? null : value;
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
export async function syncPriorityBand(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<boolean> {
  // Gate first: this returns for the large majority of rems in a big KB, before
  // any of the ten hasPowerup reads below, let alone a write.
  if (!(await isBandEligible(rem))) return false;

  const priority = await effectivePriorityForBadge(plugin, rem);
  const desired = priority === null ? null : bandForPriority(priority);

  const present: number[] = [];
  for (let band = 0; band < BAND_COUNT; band++) {
    if (await rem.hasPowerup(bandPowerupCode(band))) present.push(band);
  }

  // Already correct — and exactly one tag, so no stale bands to clean up.
  if (present.length === 1 && present[0] === desired) return false;

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

      done += batch.length;
      // Console every batch so progress is visible even when toasts are
      // throttled; toast only every 10% so a long run does not spam them.
      console.log(`[PriorityBands] ${done}/${total} band tags removed`);
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
 * `onProgress` fires every 50 rems so a KB-wide refresh can report progress
 * rather than looking hung — the same cadence removeAllPriorityBands uses.
 */
export async function syncPriorityBands(
  plugin: RNPlugin,
  remIds: string[],
  onProgress?: (done: number, total: number, changed: number) => void
): Promise<number> {
  let changed = 0;
  let done = 0;
  for (const remId of remIds) {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      try {
        if (await syncPriorityBand(plugin, rem)) changed++;
      } catch (err) {
        console.error('[PriorityBands] sync failed for', remId, err);
      }
    }
    done++;
    if (onProgress && (done % 50 === 0 || done === remIds.length)) {
      onProgress(done, remIds.length, changed);
    }
  }
  return changed;
}

/**
 * The badge stylesheet. Scoped to `.tree-node--table-cell` so it only appears
 * where the real widget cannot follow — outside tables `priority_editor` still
 * renders the exact number and stays the better badge.
 *
 * Drawn in the cell's top-right corner. `.rem-text` is the cell's positioned
 * wrapper; the OPEN and ⋯ buttons share that corner but only fade in on hover,
 * so the badge sits under them at a lower z-index rather than fighting for space.
 */
export function buildPriorityBandCSS(colorForBand: (band: number) => string): string {
  const rules = Array.from({ length: BAND_COUNT }, (_, band) => {
    const sel = `.tree-node--table-cell .rem[data-rem-tags~="${bandTagSlug(band)}"] .rem-text`;
    return `
${sel}::before {
  content: "${bandLabel(band)}";
  background: ${colorForBand(band)};
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
`;
