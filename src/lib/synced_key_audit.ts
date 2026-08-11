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
import { flashcardHistorySpec, remHistorySpec, shardKey } from './history_shards';

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

/** RemNote's documented ceilings: 900KB for a single synced value, 10MB for a
 *  plugin's whole synced footprint. Measured sizes here are the UTF-8 length of
 *  `JSON.stringify(value)` — a close proxy for what gets synced, not the exact
 *  on-disk figure, which we have no way to read. */
export const PER_KEY_BYTE_LIMIT = 900 * 1024;
export const TOTAL_BYTE_BUDGET = 10 * 1024 * 1024;
/** Flag a key once it passes half of the per-key ceiling — enough runway to act. */
const SIZE_WARN_RATIO = 0.5;
/** How many of the biggest keys to keep for the report. */
const LARGEST_KEYS_KEPT = 20;

/** Probe concurrency. Each getSynced is an IPC round trip; the bridge chokes
 *  well before this becomes a throughput win, so keep it modest. */
const PROBE_CONCURRENCY = 12;

export type ProbeState = 'live' | 'nulled' | 'absent';

/** The same value measured every way RemNote could plausibly be counting it.
 *  We do not know which unit the 900 KB ceiling is expressed in, and the units
 *  differ by up to 2× — a key that looks like 57% of the limit in UTF-8 is over
 *  the limit in UTF-16. `calibratePerKeyLimit` settles it empirically. */
export interface SizeBreakdown {
  /** `JSON.stringify(value).length` — UTF-16 code units. */
  chars: number;
  /** UTF-8 bytes of the JSON. What every earlier audit reported. */
  utf8: number;
  /** UTF-16 bytes (chars × 2): what a host measuring JS string memory sees. */
  utf16: number;
  /** UTF-8 bytes of the JSON escaped once more, as when a value is stored as a
   *  string field inside another JSON document. */
  escaped: number;
}

export interface KeySize {
  key: string;
  /** UTF-8 bytes — kept as the primary figure so totals stay comparable. */
  bytes: number;
  chars?: number;
  utf16?: number;
  escaped?: number;
}

/** The largest of the measurements we have for a key: the only figure safe to
 *  compare against the per-key ceiling while the accounting unit is unknown. */
export function worstCaseBytes(size: KeySize): number {
  return Math.max(size.bytes, size.utf16 ?? 0, size.escaped ?? 0);
}

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
  /** Sum of measured sizes of this family's live keys. */
  bytes: number;
  /** The single fattest key in this family, if any. */
  largest?: KeySize;
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

/** One filler alphabet's answer to "how big a value does RemNote actually take?" */
export interface LimitProbe {
  label: string;
  utf8PerChar: number;
  /** Largest payload the write accepted, and the smallest one it rejected. */
  acceptedChars: number;
  rejectedChars: number | null;
  /** The accepted payload expressed in each candidate accounting unit. */
  acceptedUtf8: number;
  acceptedUtf16: number;
  writes: number;
}

export interface PerKeyLimitReport {
  probes: LimitProbe[];
  documentedLimit: number;
  /** Which unit best explains the measured ceilings, and how confident we are. */
  verdict: string;
  /** The unit whose measured ceiling is most consistent across alphabets. */
  unit: 'utf8' | 'utf16' | 'chars' | 'unknown';
  /** Ceiling in that unit, averaged over the probes. */
  measuredLimit: number;
  error?: string;
}

export interface FieldCost {
  field: string;
  /** UTF-8 bytes this field contributes across every entry, key name included. */
  bytes: number;
  share: number;
  present: number;
  longest: number;
}

export interface TrimOption {
  label: string;
  maxEntries?: number;
  stringLimit?: number;
  dropFields?: string[];
}

export interface Projection {
  label: string;
  utf8: number;
  worst: number;
  savedPct: number;
  entries: number;
}

/** How a low-cardinality field's values split the array — the measurement that
 *  says whether sharding the key on that field would actually buy anything. */
export interface ValueDistribution {
  field: string;
  values: { value: string; count: number; bytes: number; share: number }[];
}

export interface ArrayKeyAnatomy {
  key: string;
  exists: boolean;
  isArray: boolean;
  entries: number;
  size: SizeBreakdown;
  worst: number;
  perKeyLimit: number;
  fields: FieldCost[];
  distributions: ValueDistribution[];
  entryBytes: { avg: number; median: number; p95: number; max: number };
  largestEntries: { index: number; bytes: number; preview: string }[];
  /** Running UTF-8 total over the first N entries — what a retention cap buys. */
  cumulative: { entries: number; utf8: number }[];
  oldest?: number;
  newest?: number;
  projections: Projection[];
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
  /** Total measured size of every live key we could name. */
  totalBytes: number;
  perKeyLimit: number;
  totalBudget: number;
  /** The fattest keys found, biggest first. */
  largestKeys: KeySize[];
  /** Keys past half the per-key ceiling — the ones worth restructuring. */
  sizeWarnings: KeySize[];
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

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** UTF-8 byte length of a value's JSON form. Falls back to the string length
 *  where TextEncoder is unavailable, which only under-counts non-ASCII. */
function measureBytes(value: unknown): number {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    return 0; // circular or otherwise unserializable — should not happen for stored data
  }
  return utf8Bytes(json);
}

function utf8Bytes(json: string): number {
  return textEncoder ? textEncoder.encode(json).length : json.length;
}

/** Escaping a 500 KB string allocates another copy of it; only worth doing for
 *  values big enough that the distinction can matter. */
const ESCAPE_MEASURE_THRESHOLD = 16 * 1024;

export function measureSizes(value: unknown): SizeBreakdown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    return { chars: 0, utf8: 0, utf16: 0, escaped: 0 };
  }
  const utf8 = utf8Bytes(json);
  const escaped =
    utf8 >= ESCAPE_MEASURE_THRESHOLD ? utf8Bytes(JSON.stringify(json)) : utf8 + 2;
  return { chars: json.length, utf8, utf16: json.length * 2, escaped };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function probeKey(
  plugin: RNPlugin,
  key: string
): Promise<{ state: ProbeState; size: SizeBreakdown }> {
  const empty: SizeBreakdown = { chars: 0, utf8: 0, utf16: 0, escaped: 0 };
  try {
    const value = await plugin.storage.getSynced(key);
    if (value === undefined) return { state: 'absent', size: empty };
    if (value === null) return { state: 'nulled', size: empty };
    // Measure and drop the value immediately — holding thousands of them would
    // cost more memory than the storage we're auditing.
    return { state: 'live', size: measureSizes(value) };
  } catch {
    // A read that throws tells us nothing about existence; treat as absent so we
    // never over-count, and let the unaccounted figure absorb it.
    return { state: 'absent', size: empty };
  }
}

async function probeFamily(
  plugin: RNPlugin,
  candidates: FamilyCandidates,
  onProgress?: (done: number, total: number) => void,
  onLiveKey?: (entry: KeySize) => void
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
    bytes: 0,
    sample: [],
    disposable: [],
    note: candidates.note,
  };

  for (let i = 0; i < keys.length; i += PROBE_CONCURRENCY) {
    const chunk = keys.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(chunk.map((k) => probeKey(plugin, k)));
    results.forEach(({ state, size }, j) => {
      const key = chunk[j];
      const bytes = size.utf8;
      if (state === 'live') {
        const entry: KeySize = {
          key,
          bytes,
          chars: size.chars,
          utf16: size.utf16,
          escaped: size.escaped,
        };
        report.live++;
        report.bytes += bytes;
        if (!report.largest || bytes > report.largest.bytes) report.largest = entry;
        onLiveKey?.(entry);
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
      // Pre-shard globals. Drained into per-KB shards on first read; they linger
      // holding [] (or the entries no session could place yet).
      flashcardHistorySpec.legacyKey,
      remHistorySpec.legacyKey,
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

  // 3b. History shards — one key per KB for each of the two jump-lists.
  families.push({
    family: 'History shards (per KB)',
    pattern: '{flashcardHistoryData|remData}_{kbId}',
    coverage: 'partial',
    note: 'Same kbId discovery limits as the sorting settings above.',
    keys: kbIds.flatMap((kbId) => [
      shardKey(flashcardHistorySpec, kbId),
      shardKey(remHistorySpec, kbId),
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
  const { state } = await probeKey(plugin, neverWritten);
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
  // Running top-N by size. Kept as a plain sorted array — N is tiny, and the
  // alternative (retaining every live key's size) would be thousands of entries.
  const largestKeys: KeySize[] = [];
  const recordSize = (entry: KeySize) => {
    if (largestKeys.length < LARGEST_KEYS_KEPT) {
      largestKeys.push(entry);
      largestKeys.sort((a, b) => b.bytes - a.bytes);
    } else if (entry.bytes > largestKeys[largestKeys.length - 1].bytes) {
      largestKeys[largestKeys.length - 1] = entry;
      largestKeys.sort((a, b) => b.bytes - a.bytes);
    }
  };

  for (const family of candidates) {
    const report = await probeFamily(
      plugin,
      family,
      (chunkDone, chunkTotal) => {
        onProgress?.(
          `Probing ${family.family}: ${chunkDone}/${chunkTotal} (${done + chunkDone}/${totalCandidates} total)…`
        );
      },
      recordSize
    );
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
  const totalBytes = reports.reduce((s, r) => s + r.bytes, 0);

  const result: AuditResult = {
    durationMs: Date.now() - started,
    families: reports,
    totalBytes,
    perKeyLimit: PER_KEY_BYTE_LIMIT,
    totalBudget: TOTAL_BYTE_BUDGET,
    largestKeys,
    sizeWarnings: largestKeys.filter(
      (k) => worstCaseBytes(k) >= PER_KEY_BYTE_LIMIT * SIZE_WARN_RATIO
    ),
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
    [...result.families]
      .sort((a, b) => b.bytes - a.bytes)
      .map((f) => ({
        family: f.family,
        probed: f.probed,
        live: f.live,
        nulled: f.nulled,
        size: formatBytes(f.bytes),
        largest: f.largest ? formatBytes(f.largest.bytes) : '—',
        coverage: f.coverage,
      }))
  );
  console.log(
    `TOTAL — probed ${result.totals.probed}, live ${result.totals.live}, nulled ${result.totals.nulled}`
  );
  console.log(`Occupying slots: ${result.occupied} of ${result.cap}`);
  console.log(
    `Measured footprint: ${formatBytes(result.totalBytes)} of ${formatBytes(result.totalBudget)} ` +
      `(${((result.totalBytes / result.totalBudget) * 100).toFixed(1)}% of the plugin budget)`
  );
  if (result.largestKeys.length > 0) {
    console.log(
      `Largest keys (per-key ceiling ${formatBytes(result.perKeyLimit)}). ` +
        'The unit RemNote counts in is unknown, so each key is shown in all three; ' +
        '"% worst" is the one to trust. Run the per-key limit calibration to find out which is real.'
    );
    console.table(
      result.largestKeys.map((k) => ({
        key: k.key,
        utf8: formatBytes(k.bytes),
        utf16: k.utf16 != null ? formatBytes(k.utf16) : '—',
        escaped: k.escaped != null ? formatBytes(k.escaped) : '—',
        '% utf8': `${((k.bytes / result.perKeyLimit) * 100).toFixed(1)}%`,
        '% worst': `${((worstCaseBytes(k) / result.perKeyLimit) * 100).toFixed(1)}%`,
      }))
    );
  }
  for (const warn of result.sizeWarnings) {
    const worst = worstCaseBytes(warn);
    console.warn(
      `[KeyAudit] "${warn.key}" is ${formatBytes(warn.bytes)} UTF-8 / ${formatBytes(worst)} worst-case — ` +
        `${((worst / result.perKeyLimit) * 100).toFixed(0)}% of the ${formatBytes(result.perKeyLimit)} per-key ceiling.`
    );
  }
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

// --- per-key size ceiling: what does RemNote actually count? ----------------
//
// The audit can only measure what a value weighs in JS. RemNote rejects writes
// against a 900 KB "per-item" ceiling without telling us the unit, and the
// candidate units differ by 2× (a 512 KB UTF-8 value is 1.02 MB in UTF-16).
// That gap is exactly the band flashcardHistoryData sits in, so guessing is not
// good enough: this walks a scratch key up to the rejection point with three
// different alphabets and reads the unit off the results.
//
//   • If the ceiling lands at ~900 KB of UTF-8 for all three alphabets, RemNote
//     counts UTF-8 bytes and our audit figures were already right.
//   • If it lands at ~460 K characters regardless of alphabet, it counts UTF-16
//     bytes (string length × 2) and every audit figure must be doubled.

const SIZE_PROBE_KEY = '__ie_size_probe__';

/** Stop bisecting once the bracket is this tight — one more halving costs a
 *  multi-hundred-KB IPC write and buys nothing we would act on. */
const LIMIT_PROBE_TOLERANCE_CHARS = 4096;
/** Never write more than this in one probe, whatever the doubling suggests. */
const LIMIT_PROBE_MAX_CHARS = 4 * 1024 * 1024;

const LIMIT_PROBE_FILLERS: Array<{ label: string; char: string; utf8PerChar: number }> = [
  { label: 'ASCII (1 UTF-8 byte/char)', char: 'x', utf8PerChar: 1 },
  { label: 'Accented Latin (2 UTF-8 bytes/char)', char: 'é', utf8PerChar: 2 },
  { label: 'CJK (3 UTF-8 bytes/char)', char: '漢', utf8PerChar: 3 },
];

async function scratchWriteSucceeds(plugin: RNPlugin, payload: string): Promise<boolean> {
  try {
    await plugin.storage.setSynced(SIZE_PROBE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the real per-key ceiling by bisection on a single scratch key.
 *
 * Writes several hundred KB repeatedly, so it is deliberately a manual, opt-in
 * action: it costs sync traffic and it leaves one extra key behind (nulled at
 * the end — nulling does not free the slot, see testNullFreesSlot).
 */
export async function calibratePerKeyLimit(
  plugin: RNPlugin,
  onProgress?: (message: string) => void
): Promise<PerKeyLimitReport> {
  const probes: LimitProbe[] = [];
  const report: PerKeyLimitReport = {
    probes,
    documentedLimit: PER_KEY_BYTE_LIMIT,
    verdict: '',
    unit: 'unknown',
    measuredLimit: 0,
  };

  try {
    for (const filler of LIMIT_PROBE_FILLERS) {
      let writes = 0;
      const attempt = async (chars: number) => {
        writes++;
        onProgress?.(
          `${filler.label}: testing ${chars.toLocaleString()} chars ` +
            `(${formatBytes(chars * filler.utf8PerChar)} UTF-8)…`
        );
        return scratchWriteSucceeds(plugin, filler.char.repeat(chars));
      };

      // Bracket: double from a value we are confident fits until one is refused.
      let lo = 1024; // known-good floor; if even this fails we report it as such
      let hi = 0;
      if (!(await attempt(lo))) {
        probes.push({
          label: filler.label,
          utf8PerChar: filler.utf8PerChar,
          acceptedChars: 0,
          rejectedChars: lo,
          acceptedUtf8: 0,
          acceptedUtf16: 0,
          writes,
        });
        continue;
      }
      let candidate = lo * 2;
      while (candidate <= LIMIT_PROBE_MAX_CHARS) {
        if (await attempt(candidate)) {
          lo = candidate;
          candidate *= 2;
        } else {
          hi = candidate;
          break;
        }
      }

      // Bisect the [accepted, rejected] bracket.
      if (hi > 0) {
        while (hi - lo > LIMIT_PROBE_TOLERANCE_CHARS) {
          const mid = Math.floor((lo + hi) / 2);
          if (await attempt(mid)) lo = mid;
          else hi = mid;
        }
      }

      probes.push({
        label: filler.label,
        utf8PerChar: filler.utf8PerChar,
        acceptedChars: lo,
        rejectedChars: hi > 0 ? hi : null,
        // The stored JSON is the string plus its two quote characters.
        acceptedUtf8: lo * filler.utf8PerChar + 2,
        acceptedUtf16: (lo + 2) * 2,
        writes,
      });
    }

    // Hand the bytes back. The slot stays taken either way, but a 1 MB scratch
    // value left behind would eat 10% of the plugin's whole budget.
    onProgress?.('Releasing the scratch key…');
    await plugin.storage.setSynced(SIZE_PROBE_KEY, null);

    const usable = probes.filter((p) => p.acceptedChars > 0 && p.rejectedChars !== null);
    if (usable.length >= 2) {
      // Whichever unit gives the most consistent ceiling across alphabets is the
      // unit RemNote counts in: the other two vary with bytes-per-char.
      const candidates: Array<{ unit: PerKeyLimitReport['unit']; values: number[] }> = [
        { unit: 'utf8', values: usable.map((p) => p.acceptedUtf8) },
        { unit: 'utf16', values: usable.map((p) => p.acceptedUtf16) },
        { unit: 'chars', values: usable.map((p) => p.acceptedChars) },
      ];
      const scored = candidates.map((c) => {
        const min = Math.min(...c.values);
        const max = Math.max(...c.values);
        const mean = c.values.reduce((s, v) => s + v, 0) / c.values.length;
        return { ...c, spread: max / Math.max(1, min), mean };
      });
      scored.sort((a, b) => a.spread - b.spread);
      const best = scored[0];
      report.unit = best.spread <= 1.1 ? best.unit : 'unknown';
      report.measuredLimit = Math.round(best.mean);
      const pct = ((report.measuredLimit / PER_KEY_BYTE_LIMIT) * 100).toFixed(0);
      report.verdict =
        report.unit === 'unknown'
          ? `No unit explains all three alphabets (best spread ${best.spread.toFixed(2)}×) — the ceiling is not a plain size check. Treat the worst-case column as the budget.`
          : `RemNote counts ${best.unit === 'chars' ? 'JSON characters' : best.unit === 'utf16' ? 'UTF-16 bytes (string length × 2)' : 'UTF-8 bytes'}: ` +
            `ceiling measured at ${formatBytes(report.measuredLimit)} (${pct}% of the documented 900 KB), consistent within ${((best.spread - 1) * 100).toFixed(1)}% across alphabets.` +
            (best.unit === 'utf16'
              ? ' Every UTF-8 figure in the key audit must be doubled before comparing it to the limit.'
              : '');
    } else {
      report.verdict =
        'Inconclusive — the probe never found a rejection point (or every write failed). Check the console for the raw results.';
    }
  } catch (e) {
    report.error = String(e);
    console.error('[KeyAudit] per-key limit calibration failed', e);
  }

  logPerKeyLimitReport(report);
  return report;
}

export function logPerKeyLimitReport(report: PerKeyLimitReport): void {
  console.log('\n===== PER-KEY SIZE CEILING CALIBRATION =====');
  console.table(
    report.probes.map((p) => ({
      alphabet: p.label,
      'largest accepted': `${p.acceptedChars.toLocaleString()} chars`,
      'smallest rejected': p.rejectedChars ? `${p.rejectedChars.toLocaleString()} chars` : '—',
      'accepted UTF-8': formatBytes(p.acceptedUtf8),
      'accepted UTF-16': formatBytes(p.acceptedUtf16),
      writes: p.writes,
    }))
  );
  console.log(`Documented limit: ${formatBytes(report.documentedLimit)}`);
  console.log(`Verdict: ${report.verdict}`);
  if (report.error) console.warn(`Error: ${report.error}`);
  console.log('============================================\n');
}

// --- anatomy of one oversized key ------------------------------------------

/** Approximate UTF-8 cost of one `"field":value,` pair inside an object. */
function fieldCostBytes(field: string, value: unknown): number {
  return measureBytes(field) + 1 + measureBytes(value) + 1;
}

function truncateStrings<T>(entry: T, limit: number, dropFields: string[]): T {
  if (!entry || typeof entry !== 'object') return entry;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
    if (dropFields.includes(k)) continue;
    out[k] = typeof v === 'string' && v.length > limit ? v.substring(0, limit) : v;
  }
  return out as unknown as T;
}

const DEFAULT_TRIM_OPTIONS: TrimOption[] = [
  // The first row is what the history shards actually ship with, so an oversized
  // key can be compared against the current policy rather than only hypotheticals.
  { label: 'Shipped history-shard limits: 500 entries, text ≤ 400 chars', maxEntries: 500, stringLimit: 400 },
  { label: 'Cap at 500 entries, text ≤ 250 chars', maxEntries: 500, stringLimit: 250 },
  { label: 'Cap at 300 entries, text ≤ 250 chars', maxEntries: 300, stringLimit: 250 },
  { label: 'Cap at 300 entries, drop stored text entirely', maxEntries: 300, dropFields: ['text'] },
];

/**
 * Break one array-valued synced key down into where its bytes actually go.
 *
 * Answers the questions the size number alone cannot: how many entries, which
 * field dominates, what a retention cap would save, and how close the value is
 * to the ceiling under each candidate accounting unit.
 */
export async function analyzeArrayKey(
  plugin: RNPlugin,
  key: string,
  trimOptions: TrimOption[] = DEFAULT_TRIM_OPTIONS
): Promise<ArrayKeyAnatomy> {
  const value = await plugin.storage.getSynced(key);
  const size = measureSizes(value);
  const anatomy: ArrayKeyAnatomy = {
    key,
    exists: value !== undefined && value !== null,
    isArray: Array.isArray(value),
    entries: Array.isArray(value) ? value.length : 0,
    size,
    worst: Math.max(size.utf8, size.utf16, size.escaped),
    perKeyLimit: PER_KEY_BYTE_LIMIT,
    fields: [],
    distributions: [],
    entryBytes: { avg: 0, median: 0, p95: 0, max: 0 },
    largestEntries: [],
    cumulative: [],
    projections: [],
  };

  if (!Array.isArray(value) || value.length === 0) {
    logArrayKeyAnatomy(anatomy);
    return anatomy;
  }

  const rows = value as Record<string, unknown>[];
  const fieldTotals = new Map<string, { bytes: number; present: number; longest: number }>();
  const perEntry: number[] = [];
  let running = 0;
  // Candidate shard keys: fields whose values repeat. A field that exceeds this
  // many distinct values is an id, not a category, and is dropped from the tally.
  const MAX_DISTINCT = 25;
  const valueTotals = new Map<string, Map<string, { count: number; bytes: number }> | null>();

  rows.forEach((row, index) => {
    const bytes = measureBytes(row);
    perEntry.push(bytes);
    running += bytes;
    if (index < 25 || index % 50 === 0 || index === rows.length - 1) {
      anatomy.cumulative.push({ entries: index + 1, utf8: running });
    }
    if (row && typeof row === 'object') {
      for (const [field, v] of Object.entries(row)) {
        const cost = fieldCostBytes(field, v);
        const acc = fieldTotals.get(field) || { bytes: 0, present: 0, longest: 0 };
        acc.bytes += cost;
        acc.present++;
        acc.longest = Math.max(acc.longest, cost);
        fieldTotals.set(field, acc);

        // Tally the whole entry's weight against this field's value, so the
        // report reads "sharding on kbId would move N KB out of the hot shard".
        if (v === null || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) {
          continue;
        }
        if (!valueTotals.has(field)) valueTotals.set(field, new Map());
        const buckets = valueTotals.get(field);
        if (!buckets) continue; // already disqualified as an id-like field
        const label = String(v);
        const bucket = buckets.get(label);
        if (bucket) {
          bucket.count++;
          bucket.bytes += bytes;
        } else if (buckets.size >= MAX_DISTINCT) {
          valueTotals.set(field, null);
        } else {
          buckets.set(label, { count: 1, bytes });
        }
      }
    }
  });

  anatomy.distributions = Array.from(valueTotals.entries())
    .filter((entry): entry is [string, Map<string, { count: number; bytes: number }>] =>
      entry[1] !== null && entry[1].size > 1
    )
    .map(([field, buckets]) => ({
      field,
      values: Array.from(buckets.entries())
        .map(([label, b]) => ({
          value: label,
          count: b.count,
          bytes: b.bytes,
          share: b.bytes / Math.max(1, size.utf8),
        }))
        .sort((a, b) => b.bytes - a.bytes),
    }))
    .sort((a, b) => a.values.length - b.values.length);

  const totalFieldBytes = Array.from(fieldTotals.values()).reduce((s, f) => s + f.bytes, 0) || 1;
  anatomy.fields = Array.from(fieldTotals.entries())
    .map(([field, acc]) => ({
      field,
      bytes: acc.bytes,
      share: acc.bytes / totalFieldBytes,
      present: acc.present,
      longest: acc.longest,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const sorted = [...perEntry].sort((a, b) => a - b);
  anatomy.entryBytes = {
    avg: Math.round(perEntry.reduce((s, v) => s + v, 0) / perEntry.length),
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted[sorted.length - 1],
  };

  anatomy.largestEntries = perEntry
    .map((bytes, index) => ({ bytes, index }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10)
    .map(({ bytes, index }) => ({
      bytes,
      index,
      preview: JSON.stringify(rows[index]).substring(0, 160),
    }));

  const times = rows
    .map((r) => (typeof r.time === 'number' ? (r.time as number) : undefined))
    .filter((t): t is number => t !== undefined);
  if (times.length > 0) {
    anatomy.oldest = Math.min(...times);
    anatomy.newest = Math.max(...times);
  }

  anatomy.projections = trimOptions.map((opt) => {
    const capped = opt.maxEntries ? rows.slice(0, opt.maxEntries) : rows;
    const projected =
      opt.stringLimit !== undefined || opt.dropFields
        ? capped.map((r) => truncateStrings(r, opt.stringLimit ?? Infinity, opt.dropFields ?? []))
        : capped;
    const projSize = measureSizes(projected);
    return {
      label: opt.label,
      utf8: projSize.utf8,
      worst: Math.max(projSize.utf8, projSize.utf16, projSize.escaped),
      savedPct: 1 - projSize.utf8 / Math.max(1, size.utf8),
      entries: projected.length,
    };
  });

  logArrayKeyAnatomy(anatomy);
  return anatomy;
}

export function logArrayKeyAnatomy(a: ArrayKeyAnatomy): void {
  console.log(`\n===== KEY ANATOMY: "${a.key}" =====`);
  if (!a.exists) {
    console.log('Key is absent or null — nothing to measure.');
    console.log('===================================\n');
    return;
  }
  if (!a.isArray) {
    console.log(
      `Value is not an array — size only: ${formatBytes(a.size.utf8)} UTF-8 / ` +
        `${formatBytes(a.size.utf16)} UTF-16 / ${formatBytes(a.size.escaped)} re-escaped.`
    );
    console.log('===================================\n');
    return;
  }
  console.log(
    `${a.entries} entries · ${formatBytes(a.size.utf8)} UTF-8 · ${formatBytes(a.size.utf16)} UTF-16 · ` +
      `${formatBytes(a.size.escaped)} re-escaped → worst case ${formatBytes(a.worst)} ` +
      `(${((a.worst / a.perKeyLimit) * 100).toFixed(0)}% of the ${formatBytes(a.perKeyLimit)} ceiling)`
  );
  if (a.oldest && a.newest) {
    console.log(
      `Spans ${new Date(a.oldest).toISOString().slice(0, 10)} → ${new Date(a.newest).toISOString().slice(0, 10)} ` +
        `(${Math.round((a.newest - a.oldest) / 86400000)} days)`
    );
  }
  console.log(
    `Per entry — avg ${formatBytes(a.entryBytes.avg)}, median ${formatBytes(a.entryBytes.median)}, ` +
      `p95 ${formatBytes(a.entryBytes.p95)}, max ${formatBytes(a.entryBytes.max)}`
  );
  console.log('Where the bytes go:');
  console.table(
    a.fields.map((f) => ({
      field: f.field,
      total: formatBytes(f.bytes),
      share: `${(f.share * 100).toFixed(1)}%`,
      'present in': `${f.present}/${a.entries}`,
      'fattest instance': formatBytes(f.longest),
    }))
  );
  for (const dist of a.distributions) {
    console.log(`Split by "${dist.field}" (${dist.values.length} distinct) — would sharding on it help?`);
    console.table(
      dist.values.slice(0, 25).map((v) => ({
        value: v.value,
        entries: v.count,
        utf8: formatBytes(v.bytes),
        'share of key': `${(v.share * 100).toFixed(1)}%`,
      }))
    );
  }
  console.log('If we trimmed it:');
  console.table(
    a.projections.map((p) => ({
      option: p.label,
      entries: p.entries,
      utf8: formatBytes(p.utf8),
      'worst case': formatBytes(p.worst),
      'saves': `${(p.savedPct * 100).toFixed(0)}%`,
      'vs ceiling': `${((p.worst / a.perKeyLimit) * 100).toFixed(0)}%`,
    }))
  );
  console.log('Fattest entries:');
  console.table(
    a.largestEntries.map((e) => ({ index: e.index, size: formatBytes(e.bytes), preview: e.preview }))
  );
  console.log('===================================\n');
}
