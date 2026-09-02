// lib/card_priority/remove_scoped.ts
//
// Removing card priorities from a CHOSEN SET of rems, and putting them back.
//
// The KB-wide counterpart already exists (`removeAllCardPriorityTags`), but its
// two scopes are decided by SOURCE — every derived tag, or every tag at all —
// and neither can express "these rems here". That is the operation the batch
// panel needs: the same panel that assigned a priority to a tagged/referencing
// set has to be able to take it off the same set.
//
// WHY THIS IS UNDOABLE AND THE KB-WIDE `all` SCOPE IS NOT
//
// The KB-wide destructive scope wipes tens of thousands of rems and clears the
// shield history with them; a snapshot of that is a different tool
// (card_priority_snapshot.ts, which the hidden-slot migration refuses to run
// without). A scoped removal is small enough to carry its own before-state
// inline, so it does — captured BEFORE the first write, exactly as the card
// enablement audit does with its own switches.
//
// The restore writes the raw slots rather than going through setCardPriority.
// Same reasoning as restoreCardPrioritySnapshot: setCardPriority is gated by
// mayWriteCardPrioritySource, which silently refuses 'inherited' and 'default'
// while flashcard prioritisation is off — an undo that quietly restores only
// the manual rows is worse than no undo at all.

import { RNPlugin } from '@remnote/plugin-sdk';
import { CARD_PRIORITY_CODE, LAST_UPDATED_SLOT, SOURCE_SLOT } from './types';
import {
  getRawCardPriorityString,
  visiblePrioritySlotRetired,
  writeRawCardPriority,
} from './slot_access';
import { pruneCardPriorityCopies, stripCardPriorityTag } from './batch';
import { syncPriorityBand } from '../priority_bands';
import { updateCardPriorityCache } from './cache';
import { SuppressionLease } from '../operation_suppression';

export interface RemovedPriorityRow {
  remId: string;
  text: string;
  /** The raw stored value, from whichever slot currently holds it. */
  priority: string;
  source: string;
  lastUpdated: string;
}

export interface CardPriorityRemoval {
  takenAt: number;
  anchorText: string;
  rows: RemovedPriorityRow[];
}

export interface RemovalResult {
  removal: CardPriorityRemoval;
  removed: number;
  failed: Array<{ remId: string; text: string; error: string }>;
}

/**
 * Strip the CardPriority tag and its slots from `targets`.
 *
 * Sequential per rem, with the suppression lease held across the run: each
 * removal is three slot writes plus a powerup removal plus a band sync, and
 * firing those in parallel is what the GlobalRemChanged listener is least able
 * to absorb.
 */
export async function removeCardPriorityFromRems(
  plugin: RNPlugin,
  targets: Array<{ remId: string; text: string }>,
  anchorText: string,
  onProgress?: (done: number, total: number) => void,
): Promise<RemovalResult> {
  const rows: RemovedPriorityRow[] = [];
  const failed: RemovalResult['failed'] = [];
  const removedIds = new Set<string>();

  // Warm this realm's retired-slot memo once, before any per-rem work. A popup
  // starts cold, and the memo is what makes both the capture read and the clear
  // skip a visible Priority slot that this KB no longer registers — otherwise
  // every rem asks RemNote for a slot that does not exist, and every write of
  // one raises a host-level toast.
  await visiblePrioritySlotRetired(plugin).catch(() => false);

  const lease = new SuppressionLease(plugin);
  await lease.start();

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      try {
        const rem: any = await plugin.rem.findOne(target.remId);
        if (!rem) throw new Error('Rem not found');

        // Capture first. A rem that no longer carries the tag has nothing to
        // capture and nothing to strip — recording an empty row would make the
        // undo write a blank priority back onto it.
        if (!(await rem.hasPowerup(CARD_PRIORITY_CODE))) {
          onProgress?.(i + 1, targets.length);
          continue;
        }

        const [priority, source, lastUpdated] = await Promise.all([
          getRawCardPriorityString(rem).catch(() => ''),
          rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT).catch(() => ''),
          rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT).catch(() => ''),
        ]);

        rows.push({
          remId: target.remId,
          text: target.text,
          priority: priority ?? '',
          source: (source as string) ?? '',
          lastUpdated: (lastUpdated as string) ?? '',
        });

        await stripCardPriorityTag(rem, plugin);
        removedIds.add(target.remId);

        // The KB-wide cleanup leaves the table badge behind and tells the user
        // to run "Remove All Priority Band Tags" afterwards. A scoped removal
        // can afford the per-rem sync, so the badge goes when the priority does.
        // readBadgePriority reads the physical slot only — with the tag gone it
        // resolves to null and the band tag is dropped.
        try {
          await syncPriorityBand(plugin, rem);
        } catch (e) {
          console.warn('[CardPriority] band sync after removal failed for', target.remId, e);
        }
      } catch (e: any) {
        failed.push({ remId: target.remId, text: target.text, error: e?.message ?? String(e) });
      }
      await lease.renew();
      onProgress?.(i + 1, targets.length);
    }

    // Drop exactly these rems from the session cache and the persisted copy.
    // This is the whole cache story for a removal — see the note on
    // pruneCardPriorityCopies. No KB-wide rebuild is involved or needed.
    await pruneCardPriorityCopies(plugin, removedIds);
  } finally {
    await lease.release();
  }

  return {
    removal: { takenAt: Date.now(), anchorText, rows },
    removed: removedIds.size,
    failed,
  };
}

/** Put every captured priority back, tag included. */
export async function restoreRemovedCardPriorities(
  plugin: RNPlugin,
  removal: CardPriorityRemoval,
  onProgress?: (done: number, total: number) => void,
): Promise<{ restored: number; failed: string[] }> {
  const lease = new SuppressionLease(plugin);
  await lease.start();
  const failed: string[] = [];
  let restored = 0;

  try {
    for (let i = 0; i < removal.rows.length; i++) {
      const row = removal.rows[i];
      try {
        const rem: any = await plugin.rem.findOne(row.remId);
        if (!rem) throw new Error('Rem not found');

        if (!(await rem.hasPowerup(CARD_PRIORITY_CODE))) {
          await rem.addPowerup(CARD_PRIORITY_CODE);
        }
        // writeRawCardPriority rather than the two slots by hand: it knows which
        // slot this KB's priorities live in, so an undo run after the hidden-slot
        // migration does not resurrect the visible Priority row the migration
        // removed.
        await writeRawCardPriority(plugin, rem, row.priority);
        await Promise.all([
          rem.setPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT, row.source ? [row.source] : []),
          rem.setPowerupProperty(
            CARD_PRIORITY_CODE,
            LAST_UPDATED_SLOT,
            row.lastUpdated ? [row.lastUpdated] : [],
          ),
        ]);
        try {
          await syncPriorityBand(plugin, rem);
        } catch (e) {
          console.warn('[CardPriority] band sync after restore failed for', row.remId, e);
        }
        await updateCardPriorityCache(plugin, row.remId);
        restored++;
      } catch (e) {
        console.error('[CardPriority] restore failed for', row.remId, e);
        failed.push(row.remId);
      }
      await lease.renew();
      onProgress?.(i + 1, removal.rows.length);
    }
  } finally {
    await lease.release();
  }

  return { restored, failed };
}

/** Download the before-state as JSON, so the undo outlives the popup. */
export function downloadCardPriorityRemoval(removal: CardPriorityRemoval): boolean {
  try {
    const stamp = new Date(removal.takenAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const blob = new Blob([JSON.stringify(removal, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `card-priority-removed-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch (e) {
    console.error('[CardPriority] removal backup download blocked', e);
    return false;
  }
}
