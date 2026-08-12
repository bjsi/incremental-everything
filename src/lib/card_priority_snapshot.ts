// lib/card_priority_snapshot.ts
//
// Full backup / verify / restore of every rem's three CardPriority slot values.
//
// Built for a slot-visibility migration that was ultimately abandoned (RemNote
// applies slot options only when the slot definition Rem is created, so an
// existing knowledge base cannot be flipped by re-registration — see the note in
// register/powerups.tsx). It is kept because the capability is worth having on
// its own: any bulk operation that touches priorities — a repair pass, a batch
// re-prioritisation, a cross-KB import — deserves a way back.
//
// Three properties make it a safety net rather than a report:
//
//  * FULL, not sampled. A sample tells you something broke; a full capture puts
//    it back.
//  * Written BOTH to local storage in chunks and to a downloaded JSON file. The
//    file is the copy that survives a storage limit, a corrupted key, or the very
//    bug you are protecting against.
//  * Keyed by kbId. Plugin storage here is NOT scoped per knowledge base — that
//    is precisely why authoritative_aggregates.ts shards by kbId and why
//    history_shards.ts exists — so an unkeyed snapshot would let one KB's values
//    be restored over another's.
//
// Costs the same three reads per rem as a cache build (~92s on a 45k library).

import { RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import {
  CARD_PRIORITY_CODE,
  PRIORITY_SLOT,
  SOURCE_SLOT,
  LAST_UPDATED_SLOT,
} from './card_priority/types';

const META_PREFIX = 'card-priority-snapshot-meta';
const CHUNK_PREFIX = 'card-priority-snapshot-chunk';
/** Rows per local-storage chunk. Keeps any single key comfortably small. */
const CHUNK_SIZE = 2000;
/** Slot reads per batch, matching the cache builder. */
const READ_BATCH = 100;

/** [remId, priority, source, lastUpdated] — tuples, not objects: at 45k rows the
 *  repeated JSON keys of an object form roughly triple the stored bytes. */
export type SnapshotRow = [string, string, string, string];

export interface SnapshotMeta {
  kbId: string;
  capturedAt: number;
  count: number;
  chunkCount: number;
  /** Approximate stored size in UTF-16 bytes. Persisted rather than merely
   *  reported, because it is the number that decides whether a derived store
   *  (the persisted card-priority cache) fits, and it should still be readable
   *  long after the popup that captured it was closed. */
  approxBytes: number;
}

async function currentKbId(plugin: RNPlugin): Promise<string | null> {
  try {
    const kb = await plugin.kb.getCurrentKnowledgeBaseData();
    return kb?._id ?? null;
  } catch {
    return null;
  }
}

const metaKey = (kbId: string) => `${META_PREFIX}::${kbId}`;
const chunkKey = (kbId: string, i: number) => `${CHUNK_PREFIX}::${kbId}::${i}`;

async function readTrio(rem: PluginRem): Promise<SnapshotRow> {
  const [priority, source, lastUpdated] = await Promise.all([
    rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT),
    rem.getPowerupProperty(CARD_PRIORITY_CODE, LAST_UPDATED_SLOT),
  ]);
  return [rem._id, priority ?? '', source ?? '', lastUpdated ?? ''];
}

export interface CaptureResult {
  meta: SnapshotMeta;
  rows: SnapshotRow[];
  /** Approximate stored size, so an oversized snapshot is visible rather than
   *  silently truncated by a storage limit. */
  approxBytes: number;
  storedLocally: boolean;
  storeError?: string;
}

/**
 * Full capture of every tagged rem's three CardPriority slots.
 *
 * Costs the same three reads per rem as a cache build (~92s on a 45k library) —
 * unavoidable, and the point: this is the copy that can undo a bad flip.
 */
export async function captureCardPrioritySnapshot(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<CaptureResult> {
  const kbId = await currentKbId(plugin);
  if (!kbId) throw new Error('Could not resolve the current knowledge base id.');

  onProgress?.('Loading tagged rems…');
  const powerup = await plugin.powerup.getPowerupByCode(CARD_PRIORITY_CODE);
  const tagged = (await powerup?.taggedRem()) || [];

  const rows: SnapshotRow[] = [];
  for (let i = 0; i < tagged.length; i += READ_BATCH) {
    const batch = tagged.slice(i, i + READ_BATCH);
    rows.push(...(await Promise.all(batch.map(readTrio))));
    if (i % (READ_BATCH * 20) === 0) {
      onProgress?.(`Reading slots: ${Math.min(i + READ_BATCH, tagged.length)}/${tagged.length}`);
    }
  }

  const approxBytes = JSON.stringify(rows).length * 2; // UTF-16

  const meta: SnapshotMeta = {
    kbId,
    capturedAt: Date.now(),
    count: rows.length,
    chunkCount: Math.ceil(rows.length / CHUNK_SIZE),
    approxBytes,
  };

  let storedLocally = false;
  let storeError: string | undefined;
  try {
    onProgress?.('Writing snapshot to local storage…');
    for (let c = 0; c < meta.chunkCount; c++) {
      await plugin.storage.setLocal(
        chunkKey(kbId, c),
        rows.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE)
      );
    }
    // Meta last: its presence is what marks a snapshot as complete, so a run that
    // dies halfway through the chunks is not mistaken for a usable restore source.
    await plugin.storage.setLocal(metaKey(kbId), meta);
    storedLocally = true;
  } catch (err) {
    storeError = String(err);
  }

  return { meta, rows, approxBytes, storedLocally, storeError };
}

export async function loadSnapshot(
  plugin: RNPlugin
): Promise<{ meta: SnapshotMeta; rows: SnapshotRow[] } | null> {
  const kbId = await currentKbId(plugin);
  if (!kbId) return null;
  const meta = await plugin.storage.getLocal<SnapshotMeta>(metaKey(kbId));
  if (!meta) return null;
  const rows: SnapshotRow[] = [];
  for (let c = 0; c < meta.chunkCount; c++) {
    const chunk = await plugin.storage.getLocal<SnapshotRow[]>(chunkKey(kbId, c));
    if (chunk) rows.push(...chunk);
  }
  return { meta, rows };
}

export interface VerifyReport {
  meta: SnapshotMeta;
  total: number;
  /** Value is byte-identical to the snapshot. */
  matched: number;
  /** Had a value, still has one, but a different one. */
  changed: number;
  /** Had a value, now reads empty. The failure worth alarming on: a value that
   *  changed was probably edited, a value that vanished was probably lost. */
  stranded: number;
  /** The rem itself is gone. Not a stranding; reported separately so it cannot
   *  inflate the number that decides whether to roll back. */
  missingRem: number;
  strandedSamples: string[];
  changedSamples: string[];
  verdict: string;
}

/**
 * Re-reads every snapshotted rem and classifies what happened to its priority:
 * unchanged, changed, vanished, or the rem itself gone.
 *
 * The four buckets are kept separate on purpose. A changed value usually means
 * someone edited it between capture and verify — expected, and not a reason to
 * restore. A value that went empty means it was lost, which is. Collapsing them
 * into one "differs" count would bury the distinction that decides what to do.
 */
export async function verifyCardPrioritySnapshot(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<VerifyReport | null> {
  const snapshot = await loadSnapshot(plugin);
  if (!snapshot) return null;
  const { meta, rows } = snapshot;

  let matched = 0;
  let changed = 0;
  let stranded = 0;
  let missingRem = 0;
  const strandedSamples: string[] = [];
  const changedSamples: string[] = [];

  for (let i = 0; i < rows.length; i += READ_BATCH) {
    const batch = rows.slice(i, i + READ_BATCH);
    const results = await Promise.all(
      batch.map(async ([remId, priority]) => {
        const rem = await plugin.rem.findOne(remId);
        if (!rem) return { remId, gone: true, now: '', was: priority };
        const now = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
        return { remId, gone: false, now: now ?? '', was: priority };
      })
    );

    for (const r of results) {
      // `was` comes off the result, not a lookup back into `rows` — a .find()
      // here would make verification O(n²) and take minutes at 45k rows.
      const was = r.was ?? '';
      if (r.gone) {
        missingRem++;
      } else if (r.now === was) {
        matched++;
      } else if (was !== '' && r.now === '') {
        stranded++;
        if (strandedSamples.length < 10) strandedSamples.push(r.remId);
      } else {
        changed++;
        if (changedSamples.length < 10) changedSamples.push(`${r.remId}: ${was} → ${r.now}`);
      }
    }

    if (i % (READ_BATCH * 20) === 0) {
      onProgress?.(`Verifying: ${Math.min(i + READ_BATCH, rows.length)}/${rows.length}`);
    }
  }

  let verdict: string;
  if (stranded > 0) {
    verdict =
      `LOST: ${stranded} of ${rows.length} priorities had a value at capture and now read empty. ` +
      'Restore from snapshot, then find out what removed them.';
  } else if (changed > 0) {
    verdict =
      `${matched} unchanged, ${changed} changed value, none lost. Changes are expected if ` +
      'priorities were edited since the capture — check the samples and only restore if they ' +
      'were not.';
  } else {
    verdict =
      `CLEAN: all ${matched} priorities are byte-identical to the snapshot` +
      (missingRem > 0 ? ` (${missingRem} rems no longer exist and were skipped).` : '.');
  }

  return {
    meta,
    total: rows.length,
    matched,
    changed,
    stranded,
    missingRem,
    strandedSamples,
    changedSamples,
    verdict,
  };
}

export interface RestoreReport {
  attempted: number;
  written: number;
  skipped: number;
  errors: number;
  verdict: string;
}

/**
 * Writes snapshotted priorities back onto rems whose value no longer matches.
 *
 * Uses raw setPowerupProperty rather than setCardPriority deliberately: the
 * latter is gated by mayWriteCardPrioritySource (which would silently refuse
 * 'inherited'/'default' rows while flashcard prioritisation is off) and runs
 * syncPriorityBand. Neither belongs in a restore, whose only job is to put back
 * the exact bytes that were there.
 */
export async function restoreCardPrioritySnapshot(
  plugin: RNPlugin,
  onProgress?: (msg: string) => void
): Promise<RestoreReport | null> {
  const snapshot = await loadSnapshot(plugin);
  if (!snapshot) return null;
  const { rows } = snapshot;

  let written = 0;
  let skipped = 0;
  let errors = 0;

  await plugin.storage.setSession('plugin_operation_active', true);
  try {
    for (let i = 0; i < rows.length; i += READ_BATCH) {
      const batch = rows.slice(i, i + READ_BATCH);
      await Promise.all(
        batch.map(async ([remId, priority, source, lastUpdated]) => {
          try {
            const rem = await plugin.rem.findOne(remId);
            if (!rem) {
              skipped++;
              return;
            }
            const now = await rem.getPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT);
            if ((now ?? '') === priority) {
              skipped++;
              return;
            }
            await Promise.all([
              rem.setPowerupProperty(CARD_PRIORITY_CODE, PRIORITY_SLOT, priority ? [priority] : []),
              rem.setPowerupProperty(CARD_PRIORITY_CODE, SOURCE_SLOT, source ? [source] : []),
              rem.setPowerupProperty(
                CARD_PRIORITY_CODE,
                LAST_UPDATED_SLOT,
                lastUpdated ? [lastUpdated] : []
              ),
            ]);
            written++;
          } catch {
            errors++;
          }
        })
      );
      if (i % (READ_BATCH * 20) === 0) {
        onProgress?.(`Restoring: ${Math.min(i + READ_BATCH, rows.length)}/${rows.length}`);
      }
    }
  } finally {
    await plugin.storage.setSession('plugin_operation_active', false);
  }

  return {
    attempted: rows.length,
    written,
    skipped,
    errors,
    verdict: `Restored ${written} priorities (${skipped} already correct or gone, ${errors} errors).`,
  };
}
