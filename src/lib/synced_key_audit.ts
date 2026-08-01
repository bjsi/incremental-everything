import { RNPlugin, PluginRem, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import {
  powerupCode,
  dismissedPowerupCode,
  videoExtractPowerupCode,
  videoExtractUrlSlotCode,
  priorityShieldHistoryKey,
  documentPriorityShieldHistoryKey,
  cardPriorityShieldHistoryKey,
  documentCardPriorityShieldHistoryKey,
  cardShieldCleanupBackupIndexKey,
  debugHistoryBackupPrefix,
  noIncRemTimerKey,
  lastDetectedOSKey,
  lastDetectedPlatformKey,
  GRAPH_DATA_KEY_PREFIX,
  REVIEW_GRAPH_INDEX_KEY,
  PRIORITY_GRAPH_DATA_KEY_PREFIX,
} from './consts';
import {
  getAllPDFsInRem,
  getCurrentPageKey,
  getPageRangeKey,
  getPageHistoryKey,
  getActivePdfKey,
  getKnownPdfRemsKey,
  getKnownHtmlRemsKey,
} from './pdfUtils';
import { getLastDestinationKey } from './hierarchical_parent_selector/types';
import { snapshotKey } from './listify';
import { PRACTICED_QUEUES_HISTORY_KEY, DAILY_AGGREGATES_KEY } from './queue_aggregates';
import { AUTHORITATIVE_AGGREGATES_KEY, AUTHORITATIVE_LAST_COMPUTED_KEY } from './authoritative_aggregates';

// ---------------------------------------------------------------------------
// Synced-storage key audit
//
// RemNote 1.27.16 caps a plugin at 1000 distinct SYNCED storage keys. The SDK
// exposes no way to enumerate keys (storage.d.ts has get/set only), so the only
// way to count them is to reconstruct every key this plugin can write from the
// KB itself and probe each one with getSynced.
//
// Consequences of that approach, which the report states explicitly:
//   • Keys whose owning rem was deleted (orphans) can NOT be reconstructed.
//     They still occupy slots. `unaccounted` in the result is the estimate of
//     how many such ghosts exist: cap − (keys we found), valid only once the
//     namespace is known to be full.
//   • getSynced distinguishes three states, and the difference matters:
//       undefined → key was never written (or a write of null really deleted it)
//       null      → key EXISTS holding null, i.e. our `setSynced(k, null)`
//                   "delete" pattern left the slot occupied
//       value     → live key
//     A non-zero `nulled` count is direct evidence that nulling does not free a
//     slot, without having to run the destructive capacity experiment.
// ---------------------------------------------------------------------------

export const SYNCED_KEY_CAP = 1000;

/** Probe concurrency. Each getSynced is an IPC round trip; the bridge chokes
 *  well before this becomes a throughput win, so keep it modest. */
const PROBE_CONCURRENCY = 12;

export type ProbeState = 'live' | 'nulled' | 'absent';

export interface FamilyReport {
  family: string;
  /** Literal key, or the shape of the generated key. */
  pattern: string;
  /** How much of the family we can reconstruct from the KB. */
  coverage: 'full' | 'partial';
  probed: number;
  live: number;
  /** Keys that exist holding null — almost certainly still consuming a slot. */
  nulled: number;
  absent: number;
  /** Up to 5 example keys that came back live. */
  sample: string[];
  /** Keys safe to sacrifice in the capacity experiment (pure backup/orphan data). */
  disposable?: string[];
  note?: string;
}

export interface CapacityReport {
  atCap: boolean;
  probeKey: string;
  error?: string;
}

export interface NullFreesSlotReport {
  sacrificedKey: string;
  /** JSON of the sacrificed value, printed to console too, so it can be recovered by hand. */
  savedValue: string;
  nullFreesSlot: boolean | null;
  restored: boolean;
  steps: string[];
  error?: string;
}

export interface AuditResult {
  durationMs: number;
  families: FamilyReport[];
  totals: { probed: number; live: number; nulled: number; absent: number };
  cap: number;
  /** Named keys known to occupy a slot (live, plus nulled when that signal is usable). */
  occupied: number;
  /** cap − occupied: keys that must exist but that we could not name. */
  unaccounted: number;
  disposable: string[];
  kbIds: string[];
  scanned: {
    incRems: number;
    dismissed: number;
    allRems: number;
    pdfPairs: number;
    videoUrls: number;
  };
  /** False when a key that was never written still reads back as null — in that
   *  case the bridge coerces undefined→null and the `nulled` counts are noise. */
  nullSignalUsable: boolean;
}

interface FamilyCandidates {
  family: string;
  pattern: string;
  coverage: 'full' | 'partial';
  keys: string[];
  note?: string;
  /** Mark the whole family as disposable (backups / orphan data). */
  disposable?: boolean;
}

// --- probing ---------------------------------------------------------------

async function probeKey(plugin: RNPlugin, key: string): Promise<ProbeState> {
  try {
    const value = await plugin.storage.getSynced(key);
    if (value === undefined) return 'absent';
    if (value === null) return 'nulled';
    return 'live';
  } catch {
    // A read that throws tells us nothing about existence; treat as absent so we
    // never over-count, and let the unaccounted figure absorb it.
    return 'absent';
  }
}

async function probeFamily(
  plugin: RNPlugin,
  candidates: FamilyCandidates,
  onProgress?: (done: number, total: number) => void
): Promise<FamilyReport> {
  // The same key can be generated twice (e.g. a PDF reachable both directly and
  // as a source); counting it twice would overstate slot usage.
  const keys = Array.from(new Set(candidates.keys));
  const report: FamilyReport = {
    family: candidates.family,
    pattern: candidates.pattern,
    coverage: candidates.coverage,
    probed: keys.length,
    live: 0,
    nulled: 0,
    absent: 0,
    sample: [],
    disposable: [],
    note: candidates.note,
  };

  for (let i = 0; i < keys.length; i += PROBE_CONCURRENCY) {
    const chunk = keys.slice(i, i + PROBE_CONCURRENCY);
    const states = await Promise.all(chunk.map((k) => probeKey(plugin, k)));
    states.forEach((state, j) => {
      const key = chunk[j];
      if (state === 'live') {
        report.live++;
        if (report.sample.length < 5) report.sample.push(key);
        if (candidates.disposable) report.disposable!.push(key);
      } else if (state === 'nulled') {
        report.nulled++;
      } else {
        report.absent++;
      }
    });
    onProgress?.(Math.min(i + PROBE_CONCURRENCY, keys.length), keys.length);
    await new Promise((r) => setTimeout(r, 0)); // yield to the UI
  }

  return report;
}

// --- candidate reconstruction ----------------------------------------------

const taggedRems = async (plugin: RNPlugin, code: string): Promise<PluginRem[]> => {
  try {
    const powerup = await plugin.powerup.getPowerupByCode(code);
    return ((await powerup?.taggedRem()) || []) as PluginRem[];
  } catch (e) {
    console.warn(`[KeyAudit] Could not read rems tagged "${code}"`, e);
    return [];
  }
};

/** Every kbId that appears as a partition in the shield-history stores, plus the
 *  current one. The per-KB sorting keys are `<name>_<kbId>`, and shield history
 *  is the only place a foreign kbId is discoverable. */
async function collectKbIds(plugin: RNPlugin): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
    if (kbData?._id) ids.add(kbData._id);
  } catch {
    /* ignore */
  }
  for (const key of [
    priorityShieldHistoryKey,
    documentPriorityShieldHistoryKey,
    cardPriorityShieldHistoryKey,
    documentCardPriorityShieldHistoryKey,
  ]) {
    try {
      const raw = (await plugin.storage.getSynced<Record<string, any>>(key)) || {};
      for (const k of Object.keys(raw)) {
        // Skip the legacy flat layout, whose root keys are YYYY-MM-DD dates.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) ids.add(k);
      }
    } catch {
      /* ignore */
    }
  }
  ids.add('global'); // fallback partition used when no kb id resolves
  return Array.from(ids);
}

async function buildCandidates(
  plugin: RNPlugin,
  onProgress?: (message: string) => void
): Promise<{ families: FamilyCandidates[]; kbIds: string[]; scanned: AuditResult['scanned'] }> {
  const families: FamilyCandidates[] = [];

  // 1. Fixed keys — one slot each, always the same name.
  onProgress?.('Probing fixed keys…');
  families.push({
    family: 'Fixed keys (current)',
    pattern: '<literal>',
    coverage: 'full',
    keys: [
      'finalDrillIds',
      'flashcardHistoryData',
      'remData',
      'incrementalHistoryData', // HISTORY_KEY in history_utils.ts (not exported)
      PRACTICED_QUEUES_HISTORY_KEY,
      DAILY_AGGREGATES_KEY,
      AUTHORITATIVE_AGGREGATES_KEY,
      AUTHORITATIVE_LAST_COMPUTED_KEY,
      'queue-refresh-trigger',
      noIncRemTimerKey,
      priorityShieldHistoryKey,
      documentPriorityShieldHistoryKey,
      cardPriorityShieldHistoryKey,
      documentCardPriorityShieldHistoryKey,
      cardShieldCleanupBackupIndexKey,
      REVIEW_GRAPH_INDEX_KEY,
      lastDetectedOSKey,
      lastDetectedPlatformKey,
    ],
  });

  // 2. Legacy pre-KB-partition globals. Still read by sorting.ts as a fallback,
  //    never written any more, so they linger from older plugin versions.
  families.push({
    family: 'Legacy globals (read-only fallbacks)',
    pattern: '<literal>',
    coverage: 'full',
    keys: ['randomness', 'cardsPerRem', 'cardRandomness', 'weightSelectionK'],
  });

  // 3. Per-KB sorting settings — 5 keys per knowledge base.
  const kbIds = await collectKbIds(plugin);
  families.push({
    family: 'Sorting settings (per KB)',
    pattern: '{randomness|cardsPerRem|cardRandomness|sortingPresets|weightSelectionK}_{kbId}',
    coverage: 'partial',
    note: 'kbIds are discoverable only via shield-history partitions; KBs that never wrote shield history are invisible here.',
    keys: kbIds.flatMap((kbId) => [
      `randomness_${kbId}`,
      `cardsPerRem_${kbId}`,
      `cardRandomness_${kbId}`,
      `sortingPresets_${kbId}`,
      `weightSelectionK_${kbId}`,
    ]),
  });

  // 4. Rem universes.
  //
  // taggedRem() is only reliable for the plugin's OWN powerups — asking for the
  // built-ins (UploadedFile / Link / Document) comes back empty even in KBs full
  // of PDFs, which silently reduced whole families to zero candidates. So every
  // family keyed by a plain rem id is probed against ALL rems instead. A probe is
  // ~0.2ms, far cheaper than classifying rems one hasPowerup call at a time, and
  // it makes those families exhaustive for every rem that still exists.
  onProgress?.('Collecting IncRem / Dismissed rems…');
  const incRems = await taggedRems(plugin, powerupCode);
  const dismRems = await taggedRems(plugin, dismissedPowerupCode);
  const videoExtracts = await taggedRems(plugin, videoExtractPowerupCode);

  const readerRems = [...incRems, ...dismRems];

  // RemNote removed plugin.rem.getAll() (findMany needs ids you already have), so
  // there is no whole-KB enumeration any more. The attempt is kept for older
  // builds; when it fails these families degrade to the IncRem/Dismissed set and
  // must be reported as partial rather than exhaustive.
  onProgress?.('Enumerating all rems…');
  let allRemIds: string[] = [];
  let remEnumerationComplete = true;
  try {
    const allRems = await plugin.rem.getAll();
    allRemIds = allRems.map((r) => r._id);
  } catch (e) {
    console.warn(
      '[KeyAudit] plugin.rem.getAll() unavailable — rem-id-keyed families fall back to IncRem/Dismissed only',
      e
    );
    remEnumerationComplete = false;
    allRemIds = readerRems.map((r) => r._id);
  }
  onProgress?.(`Enumerated ${allRemIds.length} rems.`);

  // 5. PDF reading state — 3 keys per (incremental rem, PDF) pair. This is the
  //    family that scales fastest, and the usual reason the cap is hit.
  const pairKeysPage: string[] = [];
  const pairKeysRange: string[] = [];
  const pairKeysHistory: string[] = [];
  let pairCount = 0;
  for (let i = 0; i < readerRems.length; i++) {
    const rem = readerRems[i];
    if (i % 25 === 0) {
      onProgress?.(`Resolving PDFs: ${i}/${readerRems.length} rems (${pairCount} pairs so far)…`);
      await new Promise((r) => setTimeout(r, 0));
    }
    let pdfs: Array<{ rem: PluginRem }> = [];
    try {
      pdfs = await getAllPDFsInRem(plugin, rem);
    } catch {
      continue;
    }
    for (const { rem: pdfRem } of pdfs) {
      pairCount++;
      pairKeysPage.push(getCurrentPageKey(rem._id, pdfRem._id));
      pairKeysRange.push(getPageRangeKey(rem._id, pdfRem._id));
      pairKeysHistory.push(getPageHistoryKey(rem._id, pdfRem._id));
    }
  }

  families.push({
    family: 'PDF current page',
    pattern: 'incremental_current_page_{incRemId}_{pdfRemId}',
    coverage: 'partial',
    note: 'Reconstructed from live IncRem/Dismissed rems; pairs whose rem or PDF was deleted cannot be named.',
    keys: pairKeysPage,
  });
  families.push({
    family: 'PDF page range',
    pattern: 'incremental_page_range_{incRemId}_{pdfRemId}',
    coverage: 'partial',
    keys: pairKeysRange,
  });
  families.push({
    family: 'PDF page history',
    pattern: 'incremental_page_history_{incRemId}_{pdfRemId}',
    coverage: 'partial',
    keys: pairKeysHistory,
  });

  // 6. One key per rem id — probed against every rem in the KB.
  const remIdKeyed: Array<{ family: string; pattern: string; build: (id: string) => string; note?: string; disposable?: boolean }> = [
    { family: 'Active PDF for IncRem', pattern: 'active_pdf_for_{incRemId}', build: getActivePdfKey },
    { family: 'Known PDF rems index', pattern: 'known_pdf_rems_{pdfRemId}', build: getKnownPdfRemsKey },
    { family: 'Known HTML rems index', pattern: 'known_html_rems_{htmlRemId}', build: getKnownHtmlRemsKey },
    {
      family: 'Parent-selector last destination (IncRem)',
      pattern: 'parent_selector_last_dest_increm_{incRemId}',
      // A non-null context id selects the `..._increm_` shape, so the pdf id
      // passed alongside it is ignored.
      build: (id) => getLastDestinationKey('', id),
    },
    {
      family: 'Parent-selector last destination (PDF)',
      pattern: 'parent_selector_last_dest_pdf_{pdfRemId}',
      build: (id) => getLastDestinationKey(id, null),
    },
    { family: 'List-break snapshots', pattern: 'listBreakSnapshot:{remId}', build: snapshotKey },
    {
      family: 'Priority Review Document graph data',
      pattern: `${GRAPH_DATA_KEY_PREFIX}{remId}`,
      build: (id) => GRAPH_DATA_KEY_PREFIX + id,
    },
    {
      family: 'Priority distribution graph data',
      pattern: `${PRIORITY_GRAPH_DATA_KEY_PREFIX}{documentId}`,
      build: (id) => PRIORITY_GRAPH_DATA_KEY_PREFIX + id,
    },
    {
      family: 'Debug history backups',
      pattern: `${debugHistoryBackupPrefix}{remId}`,
      build: (id) => debugHistoryBackupPrefix + id,
      disposable: true,
    },
  ];

  for (const entry of remIdKeyed) {
    families.push({
      family: entry.family,
      pattern: entry.pattern,
      // Exhaustive over live rems only when the KB could actually be enumerated;
      // otherwise these are probed against IncRem/Dismissed ids alone.
      coverage: remEnumerationComplete ? 'full' : 'partial',
      note: remEnumerationComplete
        ? entry.note
        : [entry.note, 'Probed against IncRem/Dismissed ids only — no whole-KB enumeration is available.']
            .filter(Boolean)
            .join(' '),
      disposable: entry.disposable,
      keys: allRemIds.map(entry.build),
    });
  }

  // 7. Video keys are keyed by URL, so they need the URL read off the rem. Only
  //    reader rems can reach the video player, so that is the whole population.
  const videoUrls = new Set<string>();
  for (let i = 0; i < readerRems.length; i++) {
    if (i % 100 === 0) {
      onProgress?.(`Reading video URLs: ${i}/${readerRems.length}…`);
      await new Promise((r) => setTimeout(r, 0));
    }
    const r = readerRems[i];
    try {
      if (!(await r.hasPowerup(BuiltInPowerupCodes.Link))) continue;
      const url = await r.getPowerupProperty<BuiltInPowerupCodes.Link>(BuiltInPowerupCodes.Link, 'URL');
      if (url && typeof url === 'string' && ['youtube', 'youtu.be'].some((x) => url.toLowerCase().includes(x))) {
        videoUrls.add(url);
      }
    } catch {
      continue;
    }
  }
  for (const r of videoExtracts) {
    try {
      const url = await r.getPowerupProperty(videoExtractPowerupCode, videoExtractUrlSlotCode);
      if (url) videoUrls.add(String(url));
    } catch {
      /* ignore */
    }
  }
  families.push({
    family: 'Video position / playback rate',
    pattern: '{videoUrl}-position | {videoUrl}-playbackRate',
    coverage: 'partial',
    note: 'Keyed by URL, not rem id — a URL that changed or whose rem was deleted leaves an unnameable orphan.',
    keys: Array.from(videoUrls).flatMap((url) => [`${url}-position`, `${url}-playbackRate`]),
  });

  // 8. Review-graph keys named by the synced index. Their rems are usually gone
  //    (the review document was deleted), which is exactly why the index exists —
  //    these ids are unreachable from the rem sweep above.
  const reviewIndex =
    (await plugin.storage.getSynced<Array<{ remId: string }>>(REVIEW_GRAPH_INDEX_KEY)) || [];
  families.push({
    family: 'Priority Review Document graph data (from index)',
    pattern: `${GRAPH_DATA_KEY_PREFIX}{remId}`,
    coverage: 'full',
    note: `Named by the synced index (${reviewIndex.length} entries), including rems that no longer exist. This is the family whose write is currently failing.`,
    keys: reviewIndex.map((e) => GRAPH_DATA_KEY_PREFIX + e.remId),
  });

  // 9. Card-shield cleanup backups — disposable, and fully enumerable.
  const cleanupBackupIndex =
    (await plugin.storage.getSynced<string[]>(cardShieldCleanupBackupIndexKey)) || [];
  families.push({
    family: 'Card-shield cleanup backups',
    pattern: 'card-shield-cleanup-backup-{kbId}-{timestamp}',
    coverage: 'full',
    note: 'Fully enumerable — this family keeps its own index.',
    disposable: true,
    keys: cleanupBackupIndex,
  });

  return {
    families,
    kbIds,
    scanned: {
      incRems: incRems.length,
      dismissed: dismRems.length,
      allRems: allRemIds.length,
      pdfPairs: pairCount,
      videoUrls: videoUrls.size,
    },
  };
}

// --- public API ------------------------------------------------------------

/** Read a key that has certainly never been written. If it comes back as
 *  anything other than undefined, the bridge coerces "absent" into that value
 *  and the live/nulled/absent split cannot be trusted. */
async function calibrateNullSignal(plugin: RNPlugin): Promise<boolean> {
  const neverWritten = `__ie_key_audit_calibration_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const state = await probeKey(plugin, neverWritten);
  if (state !== 'absent') {
    console.warn(
      `[KeyAudit] Calibration: an unwritten key read back as "${state}" — undefined/null are indistinguishable, ` +
        'so the "nulled" column is meaningless on this build. Use the capacity experiment instead.'
    );
    return false;
  }
  return true;
}

export async function auditSyncedKeys(
  plugin: RNPlugin,
  onProgress?: (message: string) => void
): Promise<AuditResult> {
  const started = Date.now();
  onProgress?.('Calibrating absent-vs-null signal…');
  const nullSignalUsable = await calibrateNullSignal(plugin);
  const { families: candidates, kbIds, scanned } = await buildCandidates(plugin, onProgress);

  const totalCandidates = candidates.reduce((s, f) => s + f.keys.length, 0);
  let done = 0;
  const reports: FamilyReport[] = [];
  for (const family of candidates) {
    const report = await probeFamily(plugin, family, (chunkDone, chunkTotal) => {
      onProgress?.(
        `Probing ${family.family}: ${chunkDone}/${chunkTotal} (${done + chunkDone}/${totalCandidates} total)…`
      );
    });
    done += report.probed;
    reports.push(report);
  }

  const totals = reports.reduce(
    (acc, r) => ({
      probed: acc.probed + r.probed,
      live: acc.live + r.live,
      nulled: acc.nulled + r.nulled,
      absent: acc.absent + r.absent,
    }),
    { probed: 0, live: 0, nulled: 0, absent: 0 }
  );

  // Nulled keys only count as occupied when the absent/null distinction survived
  // calibration; otherwise every unwritten key reads as null and would inflate it.
  const occupied = totals.live + (nullSignalUsable ? totals.nulled : 0);

  const result: AuditResult = {
    durationMs: Date.now() - started,
    families: reports,
    totals,
    cap: SYNCED_KEY_CAP,
    occupied,
    unaccounted: Math.max(0, SYNCED_KEY_CAP - occupied),
    disposable: reports.flatMap((r) => r.disposable || []),
    kbIds,
    scanned,
    nullSignalUsable,
  };

  logAuditResult(result);
  return result;
}

export function logAuditResult(result: AuditResult): void {
  console.log('\n========== SYNCED KEY AUDIT ==========');
  console.log(
    `Scanned: ${result.scanned.allRems} rems total (${result.scanned.incRems} IncRem, ` +
      `${result.scanned.dismissed} Dismissed), ${result.scanned.pdfPairs} IncRem×PDF pairs, ` +
      `${result.scanned.videoUrls} video URLs`
  );
  console.log(`KB ids seen: ${result.kbIds.join(', ')}`);
  console.table(
    result.families.map((f) => ({
      family: f.family,
      probed: f.probed,
      live: f.live,
      nulled: f.nulled,
      coverage: f.coverage,
    }))
  );
  console.log(
    `TOTAL — probed ${result.totals.probed}, live ${result.totals.live}, nulled ${result.totals.nulled}`
  );
  console.log(`Occupying slots: ${result.occupied} of ${result.cap}`);
  console.log(`Unaccounted (orphans we cannot name): ~${result.unaccounted}`);
  if (!result.nullSignalUsable) {
    console.warn(
      'Calibration failed: unwritten keys do not read back as undefined, so the "nulled" column is noise ' +
        'and was excluded from the occupied count. Run the null-frees-slot experiment instead.'
    );
  } else if (result.totals.nulled > 0) {
    console.warn(
      `${result.totals.nulled} key(s) exist holding null — setSynced(key, null) does NOT delete the key.`
    );
  }
  console.log(`Elapsed: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log('======================================\n');
}

const CAPACITY_PROBE_KEY = '__ie_key_audit_probe__';

/** Try to write one brand-new key. Reuses a single fixed name so this test can
 *  never cost more than one slot, ever. */
export async function probeWriteCapacity(plugin: RNPlugin): Promise<CapacityReport> {
  try {
    await plugin.storage.setSynced(CAPACITY_PROBE_KEY, Date.now());
    // Succeeded — hand the slot straight back (whether that works is exactly
    // what testNullFreesSlot answers).
    await plugin.storage.setSynced(CAPACITY_PROBE_KEY, null);
    return { atCap: false, probeKey: CAPACITY_PROBE_KEY };
  } catch (e) {
    return { atCap: true, probeKey: CAPACITY_PROBE_KEY, error: String(e) };
  }
}

/**
 * Destructive-but-reversible experiment: does `setSynced(key, null)` free a slot?
 *
 * Only run this when the namespace is already full — that is the only state in
 * which a new write failing/succeeding is informative. The sacrificial key must
 * be disposable (a backup or an orphaned graph entry); its value is dumped to
 * the console and returned before being nulled, and restored afterwards.
 */
export async function testNullFreesSlot(
  plugin: RNPlugin,
  sacrificialKey: string
): Promise<NullFreesSlotReport> {
  const steps: string[] = [];
  const report: NullFreesSlotReport = {
    sacrificedKey: sacrificialKey,
    savedValue: '',
    nullFreesSlot: null,
    restored: false,
    steps,
  };

  try {
    const before = await plugin.storage.getSynced(sacrificialKey);
    report.savedValue = JSON.stringify(before);
    console.log(`[KeyAudit] Sacrificial key "${sacrificialKey}" value saved below — recover by hand if the restore fails:`);
    console.log(report.savedValue);
    steps.push(`Saved value of ${sacrificialKey} (${report.savedValue.length} chars, also dumped to console).`);

    const preCheck = await probeWriteCapacity(plugin);
    if (!preCheck.atCap) {
      steps.push('Namespace is NOT full — a new key can already be written, so this test proves nothing. Aborted without touching the sacrificial key.');
      return report;
    }
    steps.push('Confirmed the namespace is full (a new key write was rejected).');

    await plugin.storage.setSynced(sacrificialKey, null);
    steps.push(`Wrote null to ${sacrificialKey}.`);

    const postCheck = await probeWriteCapacity(plugin);
    report.nullFreesSlot = !postCheck.atCap;
    steps.push(
      report.nullFreesSlot
        ? 'A new key could then be written → nulling DOES free a slot.'
        : 'A new key was still rejected → nulling does NOT free a slot; every key we ever wrote is permanent.'
    );

    // probeWriteCapacity already nulls its own probe key on success, so if
    // nulling frees slots the slot it borrowed is back; if it does not, the
    // sacrificial key still exists and the restore is an overwrite either way.
    await plugin.storage.setSynced(sacrificialKey, before);
    const after = await plugin.storage.getSynced(sacrificialKey);
    report.restored = JSON.stringify(after) === report.savedValue;
    steps.push(report.restored ? 'Restored the sacrificial key.' : 'RESTORE FAILED — recover the value from the console dump above.');
  } catch (e) {
    report.error = String(e);
    steps.push(`Error: ${String(e)}`);
    console.error('[KeyAudit] null-frees-slot test failed', e);
  }

  return report;
}
