// lib/card_priority/hidden_slot_migration.ts
//
// Moves this knowledge base's card priorities out of the VISIBLE `priority` slot
// into the hidden `priorityValue` one, and deletes the visible property children
// that the old slot left on every tagged rem.
//
// WHY
//
// A visible slot's value lives in a property CHILD rem. When the tagged rem is
// itself a table cell — a filled tag slot — RemNote's cell renderer sees a child,
// switches the cell to list mode, paints the child ("Priority — 31") and never
// emits the cell's own value at all. It reproduces in both table renderers, so
// it is not a simple-table quirk:
//
//   simple:   table_cell_list-* + data-rem-container-property="priority"
//   advanced: a property cell (data-rem-property="alternative-denomination-")
//             tagged cardpriority, rendered as tree-node--table-cell-list with
//             its value gone
//
// Hidden slots have no property child, so moving the value fixes every table at
// once and keeps the priority on every card. The visible slot cannot be
// re-registered hidden (RemNote applies slot options only when the slot
// definition rem is created — measured, see register/powerups.tsx), hence a new
// slot code plus this migration.
//
// SAFETY
//
// The run refuses to start without a full backup. captureCardPrioritySnapshot
// already existed for exactly this migration when it was first attempted and
// abandoned; it writes every rem's slot values to local storage in chunks AND to
// a downloaded JSON file, keyed by kbId. The undo path is
// restoreCardPrioritySnapshot, which writes the values back into the VISIBLE
// slot and so also recreates the property children — i.e. it puts the KB back to
// exactly the state it was in, table bug included.
//
// The order per rem matters and is not negotiable:
//   1. write the hidden slot
//   2. read it back — a value that did not land must not have its source deleted
//   3. only then delete the visible property child
// Deleting first and writing second would lose the value outright if the write
// failed.

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { CARD_PRIORITY_CODE, PRIORITY_SLOT, PRIORITY_VALUE_SLOT } from './types';
import {
  patchHiddenSlotRecord,
  markHiddenSlotMigrationComplete,
  readHiddenSlotRecord,
  clearHiddenSlotMigrationFlag,
} from './slot_access';
import {
  captureCardPrioritySnapshot,
  downloadCardPrioritySnapshotFile,
  restoreCardPrioritySnapshot,
  loadSnapshot,
} from '../card_priority_snapshot';
import { getPowerupSlotByCodeSafe } from '../powerup_slot_compat';
import { refIdsIn } from '../raw_slot_dump';
import { shouldUseLightMode } from '../mobileUtils';
import { clearPersistedCardPriorities } from './persistence';

const LOG = '[CardPriority hidden-slot]';

/** Rems processed per batch, matching the cache builder and the snapshot. */
const BATCH = 50;
/** Tagged rems sampled by the startup detector before giving up on a hit. */
const DETECT_SAMPLE = 400;

// ── Detection ───────────────────────────────────────────────────────────────

export interface VisibleSlotScan {
  /** Tagged rems in this KB. */
  tagged: number;
  /** Rems examined (the whole set for a full scan, DETECT_SAMPLE for a probe). */
  sampled: number;
  /** Rems found carrying a visible `priority` property child. */
  withVisibleChild: number;
  /** False when the priority slot definition rem could not be resolved, in which
   *  case withVisibleChild is meaningless and no migration should be offered. */
  resolved: boolean;
}

/**
 * Finds the visible `priority` property child of a rem, if it has one.
 *
 * A property child is identified by the rem REFERENCE to its slot definition
 * inside its own `text` — the row renders as `[ref to "Priority"] — 55`, front
 * text being the reference and the value living in `backText`. This is the same
 * signal lib/raw_slot_scan.ts classifies on (`refIdsIn(child.text)`), and the one
 * lib/raw_slot_repair.ts reads values through.
 *
 * NOT `getTagRems()`. RemNote used to tag each concrete slot instance with its
 * definition, and countDuplicatePrioritySlots in batch.ts still tests for that —
 * but post storage-overhaul a property child reports NO tags (visible in a DOM
 * dump as `data-rem-tags=""` on the property rem, with the slot reference inside
 * its text carrying `template-slot` instead). Using tags here made the whole
 * migration a silent no-op: 400 sampled rems, zero rows found, on a knowledge
 * base whose every Priority row was plainly visible.
 */
async function findVisiblePriorityChildren(
  rem: PluginRem,
  prioritySlotDefId: string
): Promise<PluginRem[]> {
  let children: PluginRem[] = [];
  try {
    children = await rem.getChildrenRem();
  } catch {
    return [];
  }
  // ALL matches, not the first. Several property rems can carry the same
  // registered slot — a fault raw_slot_scan.ts counts explicitly, and one the user
  // sees as repeated Priority rows. Returning only the first would leave every
  // duplicate row in place and the cell still broken.
  const found: PluginRem[] = [];
  for (const child of children) {
    try {
      if (refIdsIn(child.text).includes(prioritySlotDefId)) found.push(child);
    } catch {
      /* a child we cannot read is a child we must not delete */
    }
  }
  return found;
}

/**
 * Whether this KB still has visible priority rows, and how many rems carry one.
 *
 * `sample` stops after DETECT_SAMPLE rems and short-circuits on the first hit —
 * that is all the startup check needs. A full scan costs one getChildrenRem per
 * tagged rem; the reference test itself reads `child.text`, already loaded.
 */
export async function scanVisiblePrioritySlots(
  plugin: RNPlugin,
  opts: { sample?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<VisibleSlotScan> {
  const slot = await getPowerupSlotByCodeSafe(plugin, CARD_PRIORITY_CODE, PRIORITY_SLOT);
  if (!slot) {
    console.warn(`${LOG} could not resolve the visible priority slot — nothing to scan.`);
    return { tagged: 0, sampled: 0, withVisibleChild: 0, resolved: false };
  }

  const powerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE);
  const tagged = ((await powerup?.taggedRem()) || []) as PluginRem[];
  const limit = opts.sample ? Math.min(DETECT_SAMPLE, tagged.length) : tagged.length;

  let withVisibleChild = 0;
  let sampled = 0;
  for (let i = 0; i < limit; i += BATCH) {
    const batch = tagged.slice(i, Math.min(i + BATCH, limit));
    const hits = await Promise.all(
      batch.map((rem) => findVisiblePriorityChildren(rem, slot._id))
    );
    sampled += batch.length;
    withVisibleChild += hits.filter((rows) => rows.length > 0).length;
    // The probe only has to answer "any?", so stop as soon as it knows.
    if (opts.sample && withVisibleChild > 0) break;
    if (!opts.sample && i % (BATCH * 20) === 0) {
      opts.onProgress?.(`Scanning: ${sampled}/${limit}`);
    }
  }

  return { tagged: tagged.length, sampled, withVisibleChild, resolved: true };
}

// ── Migration ───────────────────────────────────────────────────────────────

export interface HiddenSlotMigrationReport {
  /** Tagged rems walked. */
  scanned: number;
  /** Values copied from the visible slot into the hidden one. */
  moved: number;
  /** Already had the same value in the hidden slot; nothing to copy. */
  alreadyHidden: number;
  /** Had a DIFFERENT value in each slot. The hidden one wins — it is what every
   *  reader uses — and the visible row is discarded rather than copied back. */
  staleVisible: number;
  /** Visible property children deleted. */
  childrenRemoved: number;
  /** Property children left in place because they had children of their own —
   *  removing one would take an unrelated subtree with it. */
  keptWithChildren: number;
  /** Hidden write did not read back. The visible child is LEFT ALONE for these. */
  writeFailed: number;
  /** Neither slot held a value — a tag with no priority, nothing to do. */
  empty: number;
  errors: number;
  errorSamples: string[];
  verdict: string;
}

/**
 * Whether a run leaves the visible slot verifiably empty across the whole KB.
 *
 * Every one of these means a row (and possibly a value) survived somewhere:
 * a write that did not read back, a row kept because it has children, or a rem
 * that errored before its row could be dealt with. Only when all three are zero
 * may the slot stop being registered — after that its reads no longer resolve, so
 * a survivor would become an unreadable value rather than a cosmetic leftover.
 *
 * `staleVisible` is deliberately NOT here: those rows were deleted, and their
 * values were the discarded ones.
 */
export function isCleanSweep(report: HiddenSlotMigrationReport): boolean {
  return report.writeFailed === 0 && report.errors === 0 && report.keptWithChildren === 0;
}

/**
 * The migration itself. Assumes the caller has taken a backup — the wrapper
 * {@link runCardPriorityHiddenSlotMigration} enforces that.
 *
 * Sets `plugin_operation_active` for the duration, like every other bulk write
 * in the plugin, so the trackers and the GlobalRemChanged cascade stand down
 * while thousands of rems change under them.
 */
export async function migrateCardPriorityToHiddenSlot(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<HiddenSlotMigrationReport> {
  const slot = await getPowerupSlotByCodeSafe(plugin, CARD_PRIORITY_CODE, PRIORITY_SLOT);
  if (!slot) {
    throw new Error(
      'Could not resolve the visible Priority slot definition. Migration aborted — ' +
        'without it the property children cannot be identified, and deleting the wrong ' +
        'child would destroy data.'
    );
  }

  const powerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE);
  const tagged = ((await powerup?.taggedRem()) || []) as PluginRem[];

  let moved = 0;
  let alreadyHidden = 0;
  let childrenRemoved = 0;
  let keptWithChildren = 0;
  let staleVisible = 0;
  let writeFailed = 0;
  let empty = 0;
  let errors = 0;
  const errorSamples: string[] = [];

  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (let i = 0; i < tagged.length; i += BATCH) {
      const batch = tagged.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (rem) => {
          try {
            const [hidden, visible] = await Promise.all([
              rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT).catch(() => null),
              rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT).catch(() => null),
            ]);

            const rows = await findVisiblePriorityChildren(rem, slot._id);
            const hasRows = rows.length > 0;

            // Deleting a property row takes its whole subtree with it, so a row
            // that has children of its own is left alone — a priority row with
            // children is not something this migration should be guessing about.
            const removeRowsSafely = async (): Promise<void> => {
              for (const row of rows) {
                const grandChildren = await row.getChildrenRem().catch(() => []);
                if (grandChildren && grandChildren.length > 0) {
                  keptWithChildren++;
                  continue;
                }
                await row.remove();
                childrenRemoved++;
              }
            };

            // Clearing the visible slot is the fallback for a rem whose value is
            // safe in the hidden slot but whose property child is not there to
            // delete — RemNote may already have dropped it.
            const clearVisibleSlot = () =>
              rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, []).catch(() => undefined);

            if (!visible) {
              // Nothing in the visible slot. An empty leftover child is still
              // worth removing: an empty property row flips a table cell into
              // list mode just the same.
              if (!hidden) empty++;
              await removeRowsSafely();
              return;
            }

            // The hidden slot ALREADY has a value: it is authoritative, because it
            // is the one every reader prefers. This is the re-run case — a first
            // run that left this rem behind, after which the plugin wrote the
            // hidden slot and the visible row went stale. Copying the visible
            // value over the hidden one here would resurrect that stale number.
            if (hidden) {
              if (hidden === visible) alreadyHidden++;
              else staleVisible++;
              if (hasRows) await removeRowsSafely();
              else await clearVisibleSlot();
              return;
            }

            await rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT, [visible]);
            // Read back before deleting the source. A write that did not land
            // must not cost the value.
            const check = await rem
              .getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_VALUE_SLOT)
              .catch(() => null);
            if (check !== visible) {
              writeFailed++;
              if (errorSamples.length < 10) {
                errorSamples.push(`${rem._id}: hidden write read back as ${check ?? 'empty'}`);
              }
              return; // leave the visible row in place — it holds the only copy
            }
            moved++;

            if (hasRows) await removeRowsSafely();
            else await clearVisibleSlot();
          } catch (err) {
            errors++;
            if (errorSamples.length < 10) errorSamples.push(`${rem._id}: ${err}`);
          }
        })
      );
      if (i % (BATCH * 10) === 0) {
        onProgress?.(`Migrating: ${Math.min(i + BATCH, tagged.length)}/${tagged.length}`);
      }
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  const clean = errors === 0 && writeFailed === 0 && keptWithChildren === 0;
  const notes: string[] = [];
  if (staleVisible > 0) {
    notes.push(
      `${staleVisible} rem(s) had a different number in each slot; the hidden one was kept, ` +
        `since that is the value the plugin has been using.`
    );
  }
  if (keptWithChildren > 0) {
    notes.push(
      `${keptWithChildren} Priority row(s) were kept because they have children of their own — ` +
        `deleting one would take that subtree with it. Their values are safe in the hidden slot; ` +
        `move or delete those children by hand and re-run to remove the rows.`
    );
  }
  if (writeFailed > 0 || errors > 0) {
    notes.push(
      `${writeFailed} hidden write(s) did not read back and ${errors} rem(s) errored. Those kept ` +
        `their visible Priority row, which still holds the value, so nothing was lost — re-run to ` +
        `retry exactly those.`
    );
  }
  const verdict =
    `Moved ${moved} priorit${moved === 1 ? 'y' : 'ies'} into the hidden slot ` +
    `(${alreadyHidden} already there), removed ${childrenRemoved} visible Priority row(s).` +
    (notes.length ? ' ' + notes.join(' ') : '');

  return {
    scanned: tagged.length,
    moved,
    alreadyHidden,
    staleVisible,
    childrenRemoved,
    keptWithChildren,
    writeFailed,
    empty,
    errors,
    errorSamples,
    verdict,
  };
}

export interface MigrationRunResult {
  report: HiddenSlotMigrationReport | null;
  backupTaken: boolean;
  backupNote: string;
  aborted?: string;
}

/**
 * Backup, then migrate, then record the flag. The only entry point callers
 * should use.
 *
 * Aborts before touching anything if the backup could not be written at all.
 * Local storage alone is accepted (it is what the in-app undo reads), and so is
 * the file alone (it survives a corrupted key) — but not neither.
 */
export async function runCardPriorityHiddenSlotMigration(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<MigrationRunResult> {
  onProgress?.('Backing up every card priority…');
  let backupTaken = false;
  let backupNote = '';
  try {
    const snapshot = await captureCardPrioritySnapshot(plugin, onProgress);
    const downloaded = downloadCardPrioritySnapshotFile(snapshot);
    backupTaken = snapshot.storedLocally || downloaded;
    backupNote =
      `${snapshot.meta.count} priorities captured ` +
      `(~${(snapshot.approxBytes / 1024 / 1024).toFixed(1)}MB). ` +
      `Local copy: ${snapshot.storedLocally ? 'written' : `FAILED — ${snapshot.storeError}`}. ` +
      `JSON file: ${downloaded ? 'downloaded' : 'FAILED'}.` +
      // The download is started from the index widget's iframe, which may not be
      // allowed to hand a file to the user. The in-app undo reads the local copy
      // and is unaffected, but the off-machine copy has to come from somewhere:
      // the Debug popup's "Capture snapshot" is a visible widget and can do it.
      (downloaded
        ? ''
        : ' Take a file copy from the Debug popup ("Capture snapshot") if you want one off-machine.');
  } catch (err) {
    backupNote = `Backup failed: ${err}`;
  }

  if (!backupTaken) {
    console.error(`${LOG} aborted — ${backupNote}`);
    return {
      report: null,
      backupTaken: false,
      backupNote,
      aborted: `No backup could be written, so nothing was changed. ${backupNote}`,
    };
  }
  console.log(`${LOG} backup ok — ${backupNote}`);

  const report = await migrateCardPriorityToHiddenSlot(plugin, onProgress);

  // `migratedAt` stops every writer (on every device, once synced) from writing
  // the visible slot — and therefore from recreating the property children this
  // run just deleted.
  //
  // Set on ANY completed run, including a partial one. Withholding it until a run
  // is spotless looks safer and is worse: the very next priority write would
  // recreate a visible child on every rem the run DID clean, un-migrating the
  // knowledge base a rem at a time. The leftovers are safe either way, because a
  // read falls back to the visible slot when the hidden one is empty — so a rem
  // whose hidden write failed keeps being read out of its surviving row until a
  // re-run moves it.
  const stamp = {
    moved: report.moved,
    childrenRemoved: report.childrenRemoved,
  };
  if (isCleanSweep(report)) {
    // Nothing anywhere in the visible slot: no failed write, no row kept back, no
    // error that could have left one. Only now may the slot stop being registered,
    // because from that point its reads no longer resolve.
    await markHiddenSlotMigrationComplete(plugin, stamp);
    console.log(`${LOG} visible slot verified empty — it will not be registered again.`);
  } else {
    await patchHiddenSlotRecord(plugin, { ...stamp, migratedAt: Date.now() });
  }

  // Values did not change, but ~every tagged rem did. Drop the warm store so the
  // next launch rebuilds from the database rather than trusting a copy taken
  // before several thousand rems were rewritten.
  await clearPersistedCardPriorities(plugin);

  console.log(`${LOG} ${report.verdict}`);
  return { report, backupTaken, backupNote };
}

/**
 * Puts the visible slot back from the backup and clears both flags, so the plugin
 * resumes registering and writing it.
 *
 * This is a real undo, not a cosmetic one: restoreCardPrioritySnapshot writes
 * through setPowerupProperty on the VISIBLE slot, which recreates the property
 * children — and with them the table-rendering bug the migration removed. That
 * is the point.
 *
 * TWO STEPS when the slot has been retired. A slot that is not registered in this
 * session cannot be written, so restoring into it would silently fail on every
 * rem. The first run therefore only clears the flags and asks for a reload; the
 * second, with the slot registered again, does the restore. Splitting it is what
 * keeps the undo honest — a single pass would report success having written
 * nothing.
 */
export async function undoCardPriorityHiddenSlotMigration(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<{ restored: boolean; note: string }> {
  const snapshot = await loadSnapshot(plugin);
  if (!snapshot) {
    return {
      restored: false,
      note:
        'No local backup found for this knowledge base. If you kept the downloaded ' +
        'JSON file, restore it from the Debug popup instead.',
    };
  }

  const record = await readHiddenSlotRecord(plugin);
  if (record?.completedAt) {
    await clearHiddenSlotMigrationFlag(plugin);
    console.log(`${LOG} flags cleared; the visible slot is registered again after a reload.`);
    return {
      restored: false,
      note:
        `Step 1 of 2 done: the old visible "Priority" slot is no longer retired.\n\n` +
        `Nothing was written yet — that slot is not registered in this session, so values ` +
        `restored into it would go nowhere. RELOAD RemNote, then run this command again to ` +
        `restore the ${snapshot.rows.length} backed-up priorities.\n\n` +
        `Your priorities are untouched and still readable in the meantime: they are in the ` +
        `hidden slot, where the migration put them.`,
    };
  }

  const report = await restoreCardPrioritySnapshot(plugin, onProgress);
  await clearHiddenSlotMigrationFlag(plugin);
  await clearPersistedCardPriorities(plugin);
  return {
    restored: true,
    note: report?.verdict ?? 'Restore finished with no report.',
  };
}

// ── The startup offer ───────────────────────────────────────────────────────

/**
 * Confirms the visible slot is empty across the WHOLE knowledge base and, if so,
 * records `completedAt` so the next launch stops registering it.
 *
 * Exhaustive by construction — a sampled scan cannot license retiring a slot,
 * because the rems it did not look at are exactly the ones that would become
 * unreadable. Runs at most once per knowledge base, and only in the two states
 * where it can pay off:
 *
 *   * `migratedAt` set but `completedAt` absent — a run finished under an earlier
 *     build that had no second flag, or a partial run has since been completed by
 *     hand. This is the case that costs a full scan; on a 2k-rem library it is a
 *     few seconds, once.
 *   * no tagged rems at all — a knowledge base that has never had a card priority.
 *     Nothing to scan, nothing to migrate, and stamping it here means the
 *     deprecated slot is never registered again, so the row cannot appear.
 */
async function completeIfVisibleSlotIsEmpty(plugin: RNPlugin): Promise<boolean> {
  const scan = await scanVisiblePrioritySlots(plugin);
  if (!scan.resolved) {
    // Either the slot definition is already gone, or it could not be read. Not
    // evidence of emptiness, so nothing is stamped.
    console.log(`${LOG} visible slot could not be resolved — leaving the record alone.`);
    return false;
  }
  if (scan.withVisibleChild > 0) {
    console.log(
      `${LOG} ${scan.withVisibleChild} of ${scan.tagged} rem(s) still carry a visible Priority ` +
        `row. Run "Migrate Card Priorities to Hidden Slot…" to move them.`
    );
    return false;
  }
  await markHiddenSlotMigrationComplete(plugin);
  console.log(
    `${LOG} visible slot verified empty across all ${scan.tagged} tagged rem(s) — it will not ` +
      `be registered again. Reload to drop the leftover "Priority" row.`
  );
  return true;
}

/**
 * Offers the migration whenever this KB still has visible priority children.
 *
 * Deliberately NOT once-only, unlike the flashcard-prioritisation opt-out: the
 * condition it detects is a live rendering bug in the user's tables, and it stays
 * broken until the migration runs. Declining offers a "never ask again" so the
 * prompt cannot become a nag that has to be endured on every launch.
 *
 * Never in light mode (mobile / web): the run is a KB-wide bulk write, which is
 * exactly what light mode exists to avoid. The record is left untouched there so
 * a desktop session still gets the offer.
 */
export async function checkCardPriorityHiddenSlotMigration(plugin: RNPlugin): Promise<void> {
  try {
    if (await shouldUseLightMode(plugin)) {
      console.log(`${LOG} offer skipped — light mode.`);
      return;
    }

    const record = await readHiddenSlotRecord(plugin);
    if (record?.completedAt) return; // fully done: slot retired, nothing to check

    // Already migrated, but never verified empty — the case a knowledge base
    // migrated by v1.0.47 is in, since that build had no `completedAt`. One full
    // scan settles it and the leftover row goes away on the next reload.
    if (record?.migratedAt) {
      await completeIfVisibleSlotIsEmpty(plugin);
      return;
    }

    if (record?.offerSuppressed) {
      console.log(`${LOG} offer suppressed by the user; run the command to migrate.`);
      return;
    }

    const probe = await scanVisiblePrioritySlots(plugin, { sample: true });
    if (!probe.resolved) return;

    if (probe.withVisibleChild === 0) {
      if (probe.tagged === 0) {
        // Never had a card priority. Retire the slot now so this knowledge base
        // never grows the row in the first place.
        await markHiddenSlotMigrationComplete(plugin);
        console.log(
          `${LOG} no card priorities in this knowledge base — the deprecated visible slot will ` +
            `not be registered again.`
        );
        return;
      }
      // Rows may still exist outside the sample, so this is not evidence of
      // emptiness and nothing is stamped. A later launch whose sample does hit one
      // will offer the migration.
      console.log(
        `${LOG} no visible Priority rows found in ${probe.sampled} of ${probe.tagged} tagged ` +
          `rem(s) — nothing to offer.`
      );
      return;
    }

    const kbName =
      (await plugin.kb.getCurrentKnowledgeBaseData())?.name || 'this knowledge base';
    await patchHiddenSlotRecord(plugin, { lastOfferedAt: Date.now() });

    const proceed = confirm(
      `🔧 Fix Card Priorities breaking your tables — "${kbName}"\n\n` +
        `Card priorities are stored in a VISIBLE "Priority" slot, which puts a "Priority — 31" ` +
        `row under every flashcard. RemNote renders that row INSTEAD OF the cell's own content ` +
        `when the flashcard sits in a table (simple and advanced tables alike), so those cells ` +
        `look empty or wrong.\n\n` +
        `This moves every priority into a hidden slot. Nothing is lost: the numbers, the ` +
        `sources, the shield, the badges and the inheritance all keep working — the rows simply ` +
        `stop being drawn, and your tables render their real content again.\n\n` +
        `WHAT CHANGES\n` +
        `  • Every priority is backed up first — to local storage AND a JSON file you keep\n` +
        `  • The "Priority" rows are deleted from your rems\n` +
        `  • Priorities can no longer be typed directly into the outline; use the Priority ` +
        `popup, Quick Priority or the batch tools\n` +
        `  • Reversible: "Undo Card Priority Hidden-Slot Migration" restores the backup\n\n` +
        `This can take a few minutes on a large knowledge base.\n\n` +
        `OK = migrate now    •    Cancel = not now`
    );

    if (!proceed) {
      const suppress = !confirm(
        `Nothing was changed.\n\n` +
          `Should I offer this again the next time RemNote starts?\n\n` +
          `OK = yes, ask me again    •    Cancel = never ask again\n\n` +
          `Either way you can run it whenever you like: Ctrl/Cmd + K → ` +
          `"Migrate Card Priorities to Hidden Slot".`
      );
      if (suppress) {
        await patchHiddenSlotRecord(plugin, { offerSuppressed: true });
        console.log(`${LOG} user chose never to be asked again.`);
      } else {
        console.log(`${LOG} user declined; will offer again next launch.`);
      }
      return;
    }

    await plugin.app.toast('Backing up card priorities…');
    const result = await runCardPriorityHiddenSlotMigration(plugin, (msg) =>
      console.log(`${LOG} ${msg}`)
    );

    if (result.aborted) {
      alert(`⚠️ Migration aborted\n\n${result.aborted}\n\nNothing on your rems was changed.`);
      return;
    }

    const r = result.report!;
    alert(
      `✅ Card priorities migrated — "${kbName}"\n\n` +
        `${r.verdict}\n\n` +
        `Backup: ${result.backupNote}\n\n` +
        (isCleanSweep(r)
          ? `The old "Priority" slot is now retired: after the reload it is no longer registered, ` +
            `so even the empty row goes away.\n\n`
          : `Re-run the command to retry the rem(s) that were left behind — they kept their ` +
            `visible Priority row, so no value was lost. The old slot stays registered until ` +
            `none are left.\n\n`) +
        `Reload RemNote to see your tables render their real content.`
    );
  } catch (err) {
    console.warn(`${LOG} startup check failed:`, err);
  }
}
