import { useState, type CSSProperties } from 'react';
import {
  renderWidget,
  usePlugin,
  useRunAsync,
  useTrackerPlugin,
  WidgetLocation,
  BuiltInPowerupCodes,
  Card,
  RichTextElementRemInterface,
  RemType,
} from '@remnote/plugin-sdk';
import { getIncrementalRemFromRem } from '../lib/incremental_rem';
import { updateIncrementalRemCache } from '../lib/incremental_rem/cache';
import { IncrementalRep, IncrementalRem } from '../lib/incremental_rem/types';
import { isPowerupPropertySafe } from '../lib/powerupSlotFilter';
import { getCardPriority } from '../lib/card_priority';
import { findNonFlashcardDescendantsWithCardPriority, getSpuriousCardPriorityTags, removeCardPriorityFromSpecificRems, removeCardPriorityFromRem, dumpRemPriorityStructure, findRogueCardPriorityRemsInSubtree, findOrphanedImportedCardPriorities } from '../lib/card_priority/batch';
import { diagnosePowerupReadPath } from '../lib/powerup_read_diagnostic';
import { dumpRawPowerupSlots } from '../lib/raw_slot_dump';
import { scanKbForDetachedSlots, SlotScanReport } from '../lib/raw_slot_scan';
import { repairDetachedCardPriorities, testDeleteOrphanProperties, RepairReport } from '../lib/raw_slot_repair';
import { getDismissedHistoryFromRem } from '../lib/dismissed';
import {
  safeRemTextToString,
  getAllPDFsInRem,
  getPageHistory,
  getPageHistoryKey,
  setPageHistory,
  getReadingStatistics,
} from '../lib/pdfUtils';
import { formatDuration } from '../lib/utils';
import { powerupCode, dismissedPowerupCode, dismissedHistorySlotCode, dismissedDateSlotCode, nextRepDateSlotCode, originalIncrementalDateSlotCode, repHistorySlotCode, prioritySlotCode,
  priorityShieldHistoryKey, documentPriorityShieldHistoryKey,
  cardPriorityShieldHistoryKey, documentCardPriorityShieldHistoryKey,
  cardShieldCleanupBackupIndexKey, cardShieldCleanupBackupPrefix,
  allCardPriorityInfoKey, allIncrementalRemKey, debugHistoryBackupPrefix,
  seenCardInSessionKey, seenRemInSessionKey,
  defaultPriorityId, displayPriorityShieldId, remnoteEnvironmentId } from '../lib/consts';
import {
  getIESettingsMigrationReport,
  getIESettingsValues,
  formatMigrationReport,
  migrateIESettings,
  SettingsMigrationReport,
} from '../lib/settings_migration';
import { IE_SETTINGS_DEFAULTS } from '../lib/settings';
import {
  auditSyncedKeys,
  probeWriteCapacity,
  testNullFreesSlot,
  calibratePerKeyLimit,
  analyzeArrayKey,
  worstCaseBytes,
  SYNCED_KEY_CAP,
  formatBytes,
  AuditResult,
  CapacityReport,
  NullFreesSlotReport,
  PerKeyLimitReport,
  ArrayKeyAnatomy,
} from '../lib/synced_key_audit';
import { AUTHORITATIVE_AGGREGATES_KEY } from '../lib/authoritative_aggregates';
import { flashcardHistorySpec, remHistorySpec, shardKey } from '../lib/history_shards';
import { CardPriorityInfo } from '../lib/card_priority';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);

// Synced-storage key holding a restore point of a rem's Incremental history,
// captured before a hand-edit so a bad edit can be rolled back.
const historyBackupKey = (remId: string) => `${debugHistoryBackupPrefix}${remId}`;

interface HistoryBackup {
  savedAt: number;
  raw: string;
}

// Validate the raw JSON string stored in the Incremental `repHist` slot against
// the authoritative IncrementalRep schema. Returns a human-readable error, or
// null if the slot is empty or a well-formed history array.
function validateHistorySlot(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null; // empty slot is legitimate
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return `Not valid JSON: ${String(e)}`;
  }
  if (!Array.isArray(parsed)) return 'Stored value is not a JSON array.';
  const result = IncrementalRep.array().safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? ` at [${first.path.join('.')}]` : '';
    return `Invalid history entry${where}: ${first?.message ?? 'schema mismatch'}`;
  }
  return null;
}

interface InfoProps {
  className: string;
  label: string;
  data: any;
}

const Info = (props: InfoProps) => {
  return (
    <div className="flex flex-col mb-2">
      <div className="font-semibold text-xs text-[var(--rn-clr-content-tertiary)] uppercase tracking-wider">{props.label}</div>
      <div className={props.className}>{props.data}</div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shield-history diagnostics
//
// The four shield-history synced keys are stored KB-aware as
//   KB-level:  { [kbId]: { [YYYY-MM-DD]: entry } }
//   doc-level: { [kbId]: { [scopeId]: { [YYYY-MM-DD]: entry } } }
// with a legacy flat layout (no kbId wrapper) that is only read on the Primary
// KB. PriorityShieldGraph reads `raw[currentKbId]` first and falls back to the
// legacy layout. When the Card graph goes blank while the IncRem graph is fine,
// the data is usually either (a) genuinely absent (never written / wiped) or
// (b) orphaned under a KB id that no longer matches the current one — e.g. after
// RemNote reassigned KB ids in the powerup/storage overhaul. This analyzer makes
// those two cases distinguishable at a glance.
// ---------------------------------------------------------------------------
const SHIELD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const countDateKeys = (obj: any): number =>
  obj && typeof obj === 'object'
    ? Object.keys(obj).filter((k) => SHIELD_DATE_RE.test(k)).length
    : 0;

/** Counts every YYYY-MM-DD leaf entry anywhere in a nested shield structure. */
function countDatesDeep(obj: any): number {
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (SHIELD_DATE_RE.test(k)) n++;
    else n += countDatesDeep(obj[k]);
  }
  return n;
}

/**
 * Additively merges `source` shield data into `target` in place. Non-date keys
 * (kbId / scopeId containers) recurse; date keys are leaf entries that are added
 * only when missing — an existing entry in `target` is never overwritten, so a
 * restore can never clobber newer/live history. Returns counts for reporting.
 */
function mergeShieldAdditive(
  target: Record<string, any>,
  source: Record<string, any>
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const k of Object.keys(source)) {
    if (SHIELD_DATE_RE.test(k)) {
      if (!(k in target)) {
        target[k] = source[k];
        added++;
      } else {
        skipped++;
      }
    } else if (
      k in target &&
      target[k] &&
      typeof target[k] === 'object' &&
      source[k] &&
      typeof source[k] === 'object'
    ) {
      const r = mergeShieldAdditive(target[k], source[k]);
      added += r.added;
      skipped += r.skipped;
    } else if (!(k in target)) {
      target[k] = source[k];
      added += countDatesDeep(source[k]);
    } else {
      skipped += countDatesDeep(source[k]);
    }
  }
  return { added, skipped };
}

interface ShieldPartitionInfo {
  kbId: string;
  scopeCount?: number;
  entryCount: number;
}

interface ShieldStoreAnalysis {
  key: string;
  label: string;
  level: 'kb' | 'doc';
  exists: boolean;
  rawIsEmpty: boolean;
  topLevelKeys: string[];
  /** Dated entries the graph's current read path can see for THIS KB. */
  currentKbDatedEntries: number;
  currentKbScopes?: number;
  /** Dated entries stored under a *different* KB id (orphaned by the read path). */
  otherKbPartitions: ShieldPartitionInfo[];
  /** Dated entries at the root (legacy flat layout — only read on the Primary KB). */
  legacyRootDatedEntries: number;
  legacyRootScopes?: number;
  status: 'ok' | 'orphaned' | 'legacy' | 'empty' | 'structure-only';
  verdict: string;
}

function analyzeShieldStore(
  key: string,
  label: string,
  level: 'kb' | 'doc',
  raw: any,
  currentKbId: string,
  isPrimary: boolean
): ShieldStoreAnalysis {
  const exists = raw != null;
  const topLevelKeys = exists && typeof raw === 'object' ? Object.keys(raw) : [];
  const rawIsEmpty = !exists || topLevelKeys.length === 0;

  let currentKbDatedEntries = 0;
  let currentKbScopes: number | undefined;
  let legacyRootDatedEntries = 0;
  let legacyRootScopes: number | undefined;
  const otherKbPartitions: ShieldPartitionInfo[] = [];

  if (exists && typeof raw === 'object') {
    if (level === 'kb') {
      // Current-KB partition: { [date]: entry }
      currentKbDatedEntries = countDateKeys(raw[currentKbId]);
      // Legacy: dates directly at the root.
      legacyRootDatedEntries = countDateKeys(raw);
      // Any other top-level key that is an object of dates = orphaned KB partition.
      for (const k of topLevelKeys) {
        if (k === currentKbId || SHIELD_DATE_RE.test(k)) continue;
        const entryCount = countDateKeys(raw[k]);
        if (entryCount > 0) otherKbPartitions.push({ kbId: k, entryCount });
      }
    } else {
      // doc-level. Current-KB partition: { [scopeId]: { [date]: entry } }
      const cur = raw[currentKbId];
      if (cur && typeof cur === 'object') {
        const scopeKeys = Object.keys(cur);
        currentKbScopes = scopeKeys.length;
        currentKbDatedEntries = scopeKeys.reduce((s, sk) => s + countDateKeys(cur[sk]), 0);
      }
      for (const k of topLevelKeys) {
        if (k === currentKbId) continue;
        const node = raw[k];
        const direct = countDateKeys(node); // dates directly under key => legacy scopeId at root
        if (direct > 0) {
          legacyRootScopes = (legacyRootScopes ?? 0) + 1;
          legacyRootDatedEntries += direct;
        } else if (node && typeof node === 'object') {
          // Might be another kbId partition: { [scopeId]: { [date]: entry } }
          const scopeKeys = Object.keys(node);
          const entries = scopeKeys.reduce((s, sk) => s + countDateKeys(node[sk]), 0);
          if (entries > 0) otherKbPartitions.push({ kbId: k, scopeCount: scopeKeys.length, entryCount: entries });
        }
      }
    }
  }

  const orphanTotal = otherKbPartitions.reduce((s, p) => s + p.entryCount, 0);

  let status: ShieldStoreAnalysis['status'];
  let verdict: string;
  if (rawIsEmpty) {
    status = 'empty';
    verdict = 'EMPTY — nothing is stored under this key at all.';
  } else if (currentKbDatedEntries > 0) {
    status = 'ok';
    verdict = `OK — ${currentKbDatedEntries} dated entr${currentKbDatedEntries === 1 ? 'y' : 'ies'} readable for the current KB.`;
  } else if (orphanTotal > 0) {
    status = 'orphaned';
    verdict =
      `ORPHANED — 0 entries for the current KB (${currentKbId}), but ${orphanTotal} entr${orphanTotal === 1 ? 'y' : 'ies'} ` +
      `exist under other KB id(s): ${otherKbPartitions.map((p) => `${p.kbId} (${p.entryCount})`).join(', ')}. ` +
      `The KB id the graph reads no longer matches where the data was written.`;
  } else if (legacyRootDatedEntries > 0) {
    status = 'legacy';
    verdict =
      `LEGACY — ${legacyRootDatedEntries} dated entr${legacyRootDatedEntries === 1 ? 'y' : 'ies'} at the root (pre-KB-aware layout). ` +
      `Only read on the Primary KB; this KB isPrimary=${isPrimary}.`;
  } else {
    status = 'structure-only';
    verdict = 'PRESENT BUT NO DATED ENTRIES — the structure exists but holds no YYYY-MM-DD entries.';
  }

  return {
    key, label, level, exists, rawIsEmpty, topLevelKeys,
    currentKbDatedEntries, currentKbScopes,
    otherKbPartitions, legacyRootDatedEntries, legacyRootScopes,
    status, verdict,
  };
}

function Debug() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );
  const remId = ctx?.contextData?.remId;
  const [refreshKey, setRefreshKey] = useState(0);
  const [isEditingHistory, setIsEditingHistory] = useState(false);
  const [historyDraft, setHistoryDraft] = useState('');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [isSavingHistory, setIsSavingHistory] = useState(false);

  // Synced-storage key audit (RemNote caps plugins at 1000 synced keys).
  const [keyAudit, setKeyAudit] = useState<AuditResult | null>(null);
  const [keyAuditProgress, setKeyAuditProgress] = useState('');
  const [isAuditingKeys, setIsAuditingKeys] = useState(false);
  const [capacityReport, setCapacityReport] = useState<CapacityReport | null>(null);
  const [nullTestReport, setNullTestReport] = useState<NullFreesSlotReport | null>(null);
  const [limitReport, setLimitReport] = useState<PerKeyLimitReport | null>(null);
  // Per-key anatomy: which key's bytes to break down. Defaults to the largest key
  // in the KB — the pre-shard `flashcardHistoryData` holds [] since it was drained
  // into per-KB shards, so naming it would only ever report an empty array.
  const [anatomyKey, setAnatomyKey] = useState(AUTHORITATIVE_AGGREGATES_KEY);
  const [anatomy, setAnatomy] = useState<ArrayKeyAnatomy | null>(null);
  // Shard names embed a 24-character kbId, so offer them as one click rather than
  // asking for them to be typed.
  const currentKbId = useTrackerPlugin(
    async (rp) => (await rp.kb.getCurrentKnowledgeBaseData())?._id,
    []
  );

  const debugData = useTrackerPlugin(
    async (rp) => {
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;

      const incrementalRem = await getIncrementalRemFromRem(rp, rem);

      // Lightweight diagnostic probe of the Incremental DATE slots. Reports whether each
      // slot's Daily Doc reference round-trips back to a date — some daily-doc rems carry
      // the DailyDocument powerup but an empty 'Date' property, which is why interval-0
      // (today-referenced) rems don't resolve from the reference and rely on the
      // history `nextRepMs` fallback instead.
      const probeDateSlot = async (slotCode: string) => {
        try {
          const richText = (await rem.getPowerupPropertyAsRichText(
            powerupCode,
            slotCode
          )) as RichTextElementRemInterface[];
          const firstId = richText?.[0]?._id;
          let dailyDocDate: string | null = null;
          let refRemText: string | null = null;
          if (firstId) {
            const refRem = await rp.rem.findOne(firstId);
            if (refRem) {
              dailyDocDate =
                (await refRem.getPowerupProperty<BuiltInPowerupCodes.DailyDocument>(
                  BuiltInPowerupCodes.DailyDocument,
                  'Date'
                )) || null;
              refRemText = await safeRemTextToString(rp, refRem.text);
            }
          }
          return {
            refId: firstId ?? null,
            refRemText,
            dailyDocDate,
            resolvedFromReference: dailyDocDate !== null,
          };
        } catch (e) {
          return { error: String(e) };
        }
      };

      // The Priority slot, verbatim. The "Priority" row in the section above is
      // incrementalRem.priority, which has already passed through
      // getIncrementalRemFromRem's `let priority = 10` fallback — so a displayed 10
      // means either "10 is stored" or "the slot could not be read", and the two
      // need completely different responses. Reading the slot directly separates
      // them: `null` here with 10 above is a read failure, not a stored value.
      const probePrioritySlot = async () => {
        try {
          const property = await rem.getPowerupProperty(powerupCode, prioritySlotCode);
          const richText = await rem.getPowerupPropertyAsRichText(powerupCode, prioritySlotCode);
          const asString = richText?.length ? await rp.richText.toString(richText) : '';
          return {
            getPowerupProperty: property === '' || property == null ? null : String(property),
            richTextLength: Array.isArray(richText) ? richText.length : null,
            richTextAsString: asString === '' ? null : asString,
          };
        } catch (e) {
          return { error: String(e) };
        }
      };

      const rawSlotProbe = (await rem.hasPowerup(powerupCode))
        ? {
            priority: await probePrioritySlot(),
            nextRepDate: await probeDateSlot(nextRepDateSlotCode),
            originalIncDate: await probeDateSlot(originalIncrementalDateSlotCode),
          }
        : null;

      const cardPriority = await getCardPriority(rp, rem);
      // getCardPriority NEVER returns null: with no tag it resolves the value
      // from the nearest ancestor (or the default) and reports lastUpdated: 0.
      // So the section below renders for every rem, and its numbers say nothing
      // about whether anything is actually stored on this one. Probe the powerup
      // directly to tell "written here" from "resolved on read".
      const hasCardPriorityTag = await rem.hasPowerup('cardPriority');
      // The three slots, verbatim. hasPowerup alone is not enough: a rem can
      // carry the powerup with an EMPTY priority slot, and getCardPriority then
      // falls through to the ancestor branch — reporting source 'inherited' and
      // lastUpdated 0 exactly as an untagged rem would. Only the raw slot values
      // distinguish "written here" from "resolved on read".
      const cardPrioritySlots = {
        priority: await rem.getPowerupProperty('cardPriority', 'priority'),
        source: await rem.getPowerupProperty('cardPriority', 'prioritySource'),
        lastUpdated: await rem.getPowerupProperty('cardPriority', 'lastUpdated'),
      };
      const dismissed = await getDismissedHistoryFromRem(rp, rem);
      
      const isCardDisabledLocally = await rem.hasPowerup(BuiltInPowerupCodes.DisableCards);
      
      let isCardDisabledInAncestors = false;
      let currentParent = await rem.getParentRem();
      while (currentParent) {
         if (await currentParent.hasPowerup(BuiltInPowerupCodes.DisableCards)) {
             isCardDisabledInAncestors = true;
             break;
         }
         currentParent = await currentParent.getParentRem();
      }

      const { guaranteedRogue, suspicious } = await getSpuriousCardPriorityTags(rp, rem, false);
      const hasSpuriousTags = guaranteedRogue.length > 0 || suspicious.length > 0;

      // Validate the raw Incremental history slot and report whether a restore
      // point exists, so the UI can alert on corruption and offer a rollback.
      let historySlotError: string | null = null;
      let historyBackupExists = false;
      if (await rem.hasPowerup(powerupCode)) {
        const rawHistorySlot = await rem.getPowerupProperty(powerupCode, repHistorySlotCode);
        historySlotError = validateHistorySlot(rawHistorySlot);
        const backup = await rp.storage.getSynced<HistoryBackup>(historyBackupKey(rem._id));
        historyBackupExists = !!backup?.raw;
      }

      return {
        incrementalRem,
        rawSlotProbe,
        cardPriority,
        hasCardPriorityTag,
        cardPrioritySlots,
        dismissed,
        isCardDisabledLocally,
        isCardDisabledInAncestors,
        hasSpuriousTags,
        guaranteedRogue,
        suspicious,
        historySlotError,
        historyBackupExists,
        rem
      };
    },
    [remId, refreshKey]
  );

  const [cardCompare, setCardCompare] = useState<{
    remCards: { id: string; type: string; nextRepTime: number | null; historyLen: number; disabled: boolean }[];
    filteredCards: { id: string; type: string; nextRepTime: number | null; historyLen: number; disabled: boolean }[];
    onlyInRem: string[];
    onlyInAll: string[];
    totalKb: number;
    match: boolean;
    documentStatus: string | null;
    documentRemId: string | null;
    deckStatus: string | null;
    deckRemId: string | null;
  } | null>(null);
  const [isComparing, setIsComparing] = useState(false);
  const [isPdfDebugging, setIsPdfDebugging] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [isDumpingHistory, setIsDumpingHistory] = useState(false);
  const [isCleaningInflation, setIsCleaningInflation] = useState(false);
  const [isGlobalCleaning, setIsGlobalCleaning] = useState(false);
  const [globalScanProgress, setGlobalScanProgress] = useState<string>('');
  const [globalInflationPreview, setGlobalInflationPreview] = useState<null | {
    cutoffMs: number;
    scannedRems: number;
    affectedRems: number;
    totalStripCount: number;
    totalStrippedSeconds: number;
    perRem: Array<{
      remId: string;
      remName: string;
      remKind: 'incRem' | 'dismissed';
      perPdf: Array<NonNullable<typeof inflationPreview>['perPdf'][number]>;
    }>;
  }>(null);
  const [inflationPreview, setInflationPreview] = useState<null | {
    cutoffMs: number;
    perPdf: Array<{
      pdfRemId: string;
      pdfName: string;
      storageKey: string;
      stripCount: number;
      keptCount: number;
      strippedSecondsTotal: number;
      keptSecondsTotal: number;
      beforeTotalSeconds: number;
      afterTotalSeconds: number;
      preserved: Array<{ index: number; timestamp: number; sessionDuration: number; reason: string }>;
      stripped: Array<{ index: number; timestamp: number; sessionDuration: number; reason: string }>;
      patched: any[];
    }>;
  }>(null);
  const [isAuditingTags, setIsAuditingTags] = useState(false);
  const [tagAudit, setTagAudit] = useState<null | {
    taggedRemCount: number;
    cardRemCount: number;
    hasPowerupCount: number;
    inTaggedRemCount: number;
    powerupNotInTaggedRem: number;
    slotButNoPowerup: number;
    canonicalDefId: string | null;
    distinctDefs: Array<{ defId: string; count: number; isCanonical: boolean }>;
    unknownDefCount: number;
    verdict: string;
    sampleDivergent: string[];
  }>(null);
  const [pageHistoryDump, setPageHistoryDump] = useState<null | {
    perPdf: Array<{
      pdfRemId: string;
      pdfName: string;
      storageKey: string;
      total: number;
      entryCount: number;
      durationsCount: number;
      durationsSum: number;
      durationsMin: number | null;
      durationsMax: number | null;
      capped14400Count: number;
      raw: any[];
    }>;
  }>(null);

  const [isProbingSearch, setIsProbingSearch] = useState(false);
  const [searchProbe, setSearchProbe] = useState<null | {
    plainString: string;
    typeLabel: string;
    elements: Array<{ idx: number; kind: string; detail: string }>;
    literalCharCount: number;
    aliases: Array<{ id: string; text: string }>;
    timesSelectedInSearch: number | null;
    referencedByCount: number;
    referencesCount: number;
    flags: Record<string, boolean>;
    // Unicode / normalization
    isNFC: boolean;
    nfcDiffers: boolean;
    nfdDiffers: boolean;
    hasLeadingTrailingWhitespace: boolean;
    suspiciousChars: Array<{ index: number; char: string; codePoint: string; name: string }>;
    codePoints: Array<{ char: string; codePoint: string }>;
    // Search reproduction
    ownSearchRank: number;
    ownSearchCount: number;
    conceptSearchRank: number;
    deepSearchRank: number;
    deepSearchCount: number;
    deepConceptRank: number;
    aliasSearches: Array<{ aliasText: string; aliasId: string; count: number; rank: number }>;
    prefixSearches: Array<{ query: string; count: number; rank: number }>;
    duplicates: Array<{ id: string; text: string; type: string }>;
    aliasStructure: Array<{ id: string; text: string; type: string; isProperty: boolean; parentIsThis: boolean }>;
    // Ancestry / context
    ancestors: Array<{ id: string; text: string; type: string; powerups: string[]; portalType: string | null; hidden: string | null; isDocument: boolean }>;
    suspiciousAncestorPowerups: string[];
    ownHiddenState: string | null;
    inPortalsCount: number;
    // Verdict
    issues: string[];
  }>(null);

  const [isDumpingShield, setIsDumpingShield] = useState(false);
  const [shieldDump, setShieldDump] = useState<null | {
    currentKbId: string;
    isPrimary: boolean;
    stores: ShieldStoreAnalysis[];
    keySizes: { key: string; label: string; chars: number; approxKB: number }[];
    live: {
      allCardInfos: number;
      cardInfosWithPriority: number;
      cardInfosWithDueOverdue: number;
      cardInfosDueOverdue: number;
      allIncRems: number;
      cardPriorityTaggedRems: number;
      cardCacheLoaded: boolean | null;
      incRemCacheLoaded: boolean | null;
      seenCardIds: number;
      seenRemIds: number;
    };
  }>(null);

  // Locator for the rem named in a "Diff for <remId> is too large to sync" error.
  const [syncRemIdInput, setSyncRemIdInput] = useState('W4h9jDINr9Xr4Bcdp');
  const [isProbingSyncRem, setIsProbingSyncRem] = useState(false);
  const [syncRemProbe, setSyncRemProbe] = useState<null | {
    remId: string;
    found: boolean;
    remType: string | null;
    textPreview: string | null;
    textChars: number;
    looksLikeJson: boolean;
    jsonTopKeysPreview: string[] | null;
    powerups: string[];
    parentId: string | null;
    parentText: string | null;
    ancestorTexts: string[];
    childCount: number;
  }>(null);

  // On-screen copyable export text (mobile fallback when file/clipboard fail).
  // Raw powerup-slot dump JSON, kept on screen so it can be copied by hand where
  // the clipboard API and file download are both blocked (see handleDumpRawSlots).
  const [rawSlotDumpText, setRawSlotDumpText] = useState<string | null>(null);
  // KB-wide slot damage scan (see handleScanKb).
  const [kbScan, setKbScan] = useState<SlotScanReport | null>(null);
  const [isScanningKb, setIsScanningKb] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  // CardPriority repair + the staged orphan-deletion test (see handleRepairCardPriority).
  const [repairReport, setRepairReport] = useState<RepairReport | null>(null);
  const [isRepairingCP, setIsRepairingCP] = useState(false);
  const [repairProgress, setRepairProgress] = useState<string | null>(null);
  const [deletionProbes, setDeletionProbes] = useState<Awaited<ReturnType<typeof testDeleteOrphanProperties>> | null>(null);
  // Result of the settings-migration probe (see handleProbeSettingsPersistence).
  const [isProbingSettings, setIsProbingSettings] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationReport, setMigrationReport] = useState<SettingsMigrationReport | null>(null);
  const [storedSettings, setStoredSettings] = useState<Record<string, unknown> | null>(null);
  const [settingsProbe, setSettingsProbe] = useState<null | {
    rows: Array<{
      group: 'control' | 'never-registered' | 'de-registered';
      id: string;
      note: string;
      outcome: 'value' | 'undefined' | 'threw';
      value: string;
      error?: string;
    }>;
    anyThrew: boolean;
  }>(null);

  const [shieldExport, setShieldExport] = useState<{ full: string; cardOnly: string } | null>(null);

  // Restore of shield history from a cleanup backup or a pasted export/backup JSON.
  const [restoreJsonInput, setRestoreJsonInput] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [backupList, setBackupList] = useState<null | Array<{ key: string; backedUpAt: number | null; kbId: string | null; dateEntries: number }>>(null);
  const [restoreResult, setRestoreResult] = useState<null | { perKey: Array<{ key: string; added: number; skipped: number }>; source: string }>(null);

  if (!debugData) return null;

  const { incrementalRem, rawSlotProbe, cardPriority, hasCardPriorityTag, cardPrioritySlots, dismissed, isCardDisabledLocally, isCardDisabledInAncestors, hasSpuriousTags, guaranteedRogue, suspicious, historySlotError, historyBackupExists, rem } = debugData;

  const handleCardCompare = async () => {
    if (!remId) return;
    setIsComparing(true);
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) { await plugin.app.toast('No rem found!'); return; }

      // Walk ancestors to collect Document + Deck powerup status slots
      let documentStatus: string | null = null;
      let documentRemId: string | null = null;
      let deckStatus: string | null = null;
      let deckRemId: string | null = null;
      let cursor = await rem.getParentRem();
      while (cursor) {
        if (documentRemId === null && await cursor.hasPowerup(BuiltInPowerupCodes.Document)) {
          documentRemId = cursor._id;
          const raw = await cursor.getPowerupProperty(BuiltInPowerupCodes.Document, 'Status');
          documentStatus = raw != null ? String(raw) : '(null)';
        }
        if (deckRemId === null && await cursor.hasPowerup(BuiltInPowerupCodes.Deck)) {
          deckRemId = cursor._id;
          const raw = await cursor.getPowerupProperty(BuiltInPowerupCodes.Deck, 'Status');
          deckStatus = raw != null ? String(raw) : '(null)';
        }
        if (documentRemId && deckRemId) break;
        cursor = await cursor.getParentRem();
      }

      const remCards = await rem.getCards();
      const allCards = await plugin.card.getAll();
      const filteredCards = (allCards || []).filter((c: Card) => c.remId === remId);

      const parse = (c: Card) => ({
        id: c._id,
        type: typeof c.type === 'object' && c.type !== null ? `cloze:${(c.type as { clozeId: string }).clozeId}` : String(c.type),
        nextRepTime: c.nextRepetitionTime ?? null,
        historyLen: c.repetitionHistory?.length ?? 0,
        disabled: c.nextRepetitionTime == null,
      });

      const remCardsParsed = remCards.map(parse);
      const filteredCardsParsed = filteredCards.map(parse);
      const remIdSet = new Set(remCards.map((c: Card) => c._id));
      const filtIdSet = new Set(filteredCards.map((c: Card) => c._id));
      const onlyInRem = remCards.filter((c: Card) => !filtIdSet.has(c._id)).map((c: Card) => c._id);
      const onlyInAll = filteredCards.filter((c: Card) => !remIdSet.has(c._id)).map((c: Card) => c._id);

      const result = {
        remCards: remCardsParsed,
        filteredCards: filteredCardsParsed,
        onlyInRem,
        onlyInAll,
        totalKb: allCards?.length ?? 0,
        match: onlyInRem.length === 0 && onlyInAll.length === 0,
        documentStatus,
        documentRemId,
        deckStatus,
        deckRemId,
      };

      console.log(`\n========== CARD COMPARE: ${remId} ==========`);
      console.log('Document ancestor:', documentRemId, '| Status slot:', documentStatus);
      console.log('Deck ancestor:', deckRemId, '| Status slot:', deckStatus);
      console.log('rem.getCards():', JSON.stringify(remCardsParsed, null, 2));
      console.log('card.getAll() filtered:', JSON.stringify(filteredCardsParsed, null, 2));
      console.log('Only in rem.getCards():', onlyInRem);
      console.log('Only in card.getAll():', onlyInAll);
      console.log('Total KB cards:', result.totalKb);
      console.log('Match:', result.match);
      console.log('===========================================\n');

      setCardCompare(result);
    } finally {
      setIsComparing(false);
    }
  };

  const handleDeepLog = async () => {
    console.log(`\n=================== DEEP LOG REM: ${rem._id} ===================`);
    const tags = await rem.getTagRems();
    const mainTagsMapped = await Promise.all(tags.map(async t => ({ 
      id: t._id, 
      name: t.text ? await plugin.richText.toString(t.text) : '' 
    })));
    const mainTagsStr = mainTagsMapped.length > 0
      ? mainTagsMapped.map(t => t.name || t.id).join(', ')
      : 'None';
    console.log(`Tags: [${mainTagsStr}]`);
    
    const children = await rem.getChildrenRem();
    console.log(`Found ${children.length} total children.`);
    
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isProp = await child.isProperty();
      const isPowerupProp = await isPowerupPropertySafe(plugin, child);
      const childTags = await child.getTagRems();
      const textRaw = child.text;
      const textString = textRaw ? await plugin.richText.toString(textRaw) : '';
      
      const childTagsMapped = await Promise.all(childTags.map(async t => ({ 
        id: t._id, 
        name: t.text ? await plugin.richText.toString(t.text) : '' 
      })));
      
      const tagsStr = childTagsMapped.length > 0 
        ? childTagsMapped.map(t => t.name || t.id).join(', ') 
        : 'None';
        
      console.log(`Child ${i + 1} (${child._id}): text="${textString}", isProp=${isProp}, isPowerupProp=${isPowerupProp}, tags=[${tagsStr}]`);
    }
    console.log(`=================================================================\n`);
    await plugin.app.toast('Deep log printed to console! Please check Developer Tools.');
  };

  // Isolation probe for the RemNote runtime deprecation of
  // plugin.powerup.getPowerupSlotByCode. Confirms (a) the slot-by-code method
  // now throws "getPowerupSlotByCode is deprecated" from the app side, and
  // (b) the sibling getPowerupByCode on the same namespace still works —
  // proving the regression is isolated to getPowerupSlotByCode.
  const handleProbeSlotApi = async () => {
    console.log(`\n========== POWERUP SLOT API PROBE ==========`);

    // getPowerupByCode — control: expected to still work.
    for (const code of [powerupCode, 'cardPriority', BuiltInPowerupCodes.DailyDocument]) {
      try {
        const pu = await plugin.powerup.getPowerupByCode(code);
        console.log(`getPowerupByCode('${code}') → OK, _id=${pu?._id ?? '(undefined)'}`);
      } catch (e) {
        console.log(`getPowerupByCode('${code}') → THREW: ${String(e)}`);
      }
    }

    // getPowerupSlotByCode — the suspected-deprecated method.
    const slotCases: Array<[string, string]> = [
      [powerupCode, nextRepDateSlotCode],       // plugin powerup (Incremental)
      ['cardPriority', 'priority'],             // plugin powerup (CardPriority)
      [BuiltInPowerupCodes.PDFHighlight, 'Data'], // built-in powerup
    ];
    for (const [pu, slot] of slotCases) {
      try {
        const slotRem = await plugin.powerup.getPowerupSlotByCode(pu, slot);
        console.log(`getPowerupSlotByCode('${pu}', '${slot}') → OK, _id=${slotRem?._id ?? '(undefined)'}`);
      } catch (e) {
        console.log(`getPowerupSlotByCode('${pu}', '${slot}') → THREW: ${String(e)}`);
      }
    }

    console.log(`===========================================\n`);
    await plugin.app.toast('Slot API probe done — open DevTools console to read results.');
  };

  // Settings-migration probe. Before moving settings out of RemNote's settings
  // panel into a plugin-owned popup, we need to know how `getSetting` behaves
  // for an id that is no longer registered — that decides whether a one-time
  // seed can still read legacy values after the registrations are deleted.
  //
  // Three groups:
  //  A. control      — currently registered ids, to prove the read path works.
  //  B. never known  — ids this plugin has never registered: does the call
  //                    return undefined, or throw?
  //  C. de-registered — ids this plugin DID register in an earlier version and
  //                    no longer does. A non-undefined answer here is direct
  //                    evidence that stored values outlive their registration.
  //                    Only conclusive if the value differs from the old
  //                    default (otherwise "stored default" and "pruned, so
  //                    undefined" are indistinguishable — see note below).
  const handleProbeSettingsPersistence = async () => {
    setIsProbingSettings(true);
    try {
      type Row = {
        group: 'control' | 'never-registered' | 'de-registered';
        id: string;
        note: string;
        outcome: 'value' | 'undefined' | 'threw';
        value: string;
        error?: string;
      };

      const cases: Array<{ group: Row['group']; id: string; note: string }> = [
        // Notes read the live default out of the table — a hardcoded literal here
        // goes stale the moment a default is edited.
        { group: 'control', id: defaultPriorityId, note: `registered number, default ${JSON.stringify(IE_SETTINGS_DEFAULTS[defaultPriorityId])}` },
        { group: 'control', id: displayPriorityShieldId, note: `registered boolean, default ${JSON.stringify(IE_SETTINGS_DEFAULTS[displayPriorityShieldId])}` },
        { group: 'control', id: remnoteEnvironmentId, note: `registered dropdown, default ${JSON.stringify(IE_SETTINGS_DEFAULTS[remnoteEnvironmentId])}` },
        { group: 'never-registered', id: 'ie-probe-never-registered', note: 'never registered by any version' },
        { group: 'never-registered', id: 'ie-probe-' + Date.now(), note: 'fresh random id' },
        // Dropped when the isolated-queue boolean became the `isolated-queue-view-mode`
        // dropdown. Old default: false — so `true` is proof of survival.
        { group: 'de-registered', id: 'show-rems-as-isolated-in-queue', note: "removed boolean, old default false → 'true' proves survival" },
        // Dropped with the PDF highlight-colour feature. Old default: 'Blue' —
        // so any other colour is proof of survival.
        { group: 'de-registered', id: 'pdf-highlight-color', note: "removed dropdown, old default 'Blue' → any other colour proves survival" },
      ];

      const rows: Row[] = [];
      for (const c of cases) {
        try {
          const v = await plugin.settings.getSetting<unknown>(c.id);
          rows.push({
            ...c,
            outcome: v === undefined ? 'undefined' : 'value',
            value: v === undefined ? '(undefined)' : JSON.stringify(v),
          });
        } catch (e) {
          rows.push({ ...c, outcome: 'threw', value: '(threw)', error: String(e) });
        }
      }

      const anyThrew = rows.some((r) => r.outcome === 'threw');
      const deRegistered = rows.filter((r) => r.group === 'de-registered');
      const survived = deRegistered.filter((r) => r.outcome === 'value');

      console.log('\n========== SETTINGS MIGRATION PROBE ==========');
      for (const g of ['control', 'never-registered', 'de-registered'] as const) {
        console.log(`\n--- ${g} ---`);
        for (const r of rows.filter((x) => x.group === g)) {
          console.log(`  ${r.id} → ${r.outcome.toUpperCase()} ${r.value}${r.error ? ` :: ${r.error}` : ''}\n      (${r.note})`);
        }
      }
      console.log('\n--- Verdict ---');
      console.log(`  getSetting on an unknown id: ${anyThrew ? 'THROWS (seed needs per-id try/catch)' : 'returns undefined (safe to call)'}`);
      console.log(`  de-registered ids returning a value: ${survived.length}/${deRegistered.length}`);
      console.log('==============================================\n');

      setSettingsProbe({ rows, anyThrew });
      await plugin.app.toast('Settings migration probe done — see the report below.');
    } finally {
      setIsProbingSettings(false);
    }
  };

  // Settings migration status. Reads the durable per-setting report written by
  // lib/settings_migration.ts, so the state of the migration is inspectable
  // long after the activation that ran it.
  const loadMigrationReport = async () => {
    const report = await getIESettingsMigrationReport(plugin);
    setMigrationReport(report);
    console.log(formatMigrationReport(report));
    // The report says what the seed decided; the blob is what it actually left
    // behind. Post-v2 these differ on purpose — settings equal to their default
    // are not stored — so showing both is the only way to confirm the state.
    const values = await getIESettingsValues(plugin);
    setStoredSettings(values);
    console.log('[IESettingsMigration] stored blob:', values);
    return report;
  };

  const handleShowMigrationStatus = async () => {
    setIsMigrating(true);
    try {
      const report = await loadMigrationReport();
      await plugin.app.toast(
        report
          ? `Settings migration: ${report.complete ? 'COMPLETE' : 'INCOMPLETE'} — ${report.counts.failed} failed`
          : 'Settings migration has never run on this KB.'
      );
    } finally {
      setIsMigrating(false);
    }
  };

  // Re-reads every setting and overwrites the stored blob. For recovering a
  // migration that ran while some settings were unreadable — not part of the
  // normal path, which is merge-only.
  const handleForceRemigrate = async () => {
    setIsMigrating(true);
    try {
      const report = await migrateIESettings(plugin, { force: true });
      setMigrationReport(report);
      setStoredSettings(await getIESettingsValues(plugin));
      await plugin.app.toast(
        `Re-migrated ${report.total} settings — ${report.counts.failed} failed.`
      );
    } finally {
      setIsMigrating(false);
    }
  };

  const handleCopyMigrationReport = async () => {
    const report = migrationReport ?? (await loadMigrationReport());
    copyTextFallback(formatMigrationReport(report));
    await plugin.app.toast('Migration report copied.');
  };

  const handleEditHistory = async () => {
    // Snapshot a restore point of the current (pre-edit) slot — but only when it
    // is currently valid, so the backup always holds a known-good history and a
    // bad edit can be rolled back. If the slot is already corrupt, we keep any
    // existing (older, good) backup rather than overwriting it.
    if (remId) {
      try {
        const targetRem = await plugin.rem.findOne(remId);
        const currentRaw = targetRem
          ? await targetRem.getPowerupProperty(powerupCode, repHistorySlotCode)
          : null;
        if (currentRaw && validateHistorySlot(currentRaw) === null) {
          const backup: HistoryBackup = { savedAt: Date.now(), raw: currentRaw };
          await plugin.storage.setSynced(historyBackupKey(remId), backup);
        }
      } catch {
        /* backup is best-effort */
      }
    }
    setHistoryDraft(incrementalRem?.history ? JSON.stringify(incrementalRem.history, null, 2) : '[]');
    setHistoryError(null);
    setIsEditingHistory(true);
  };

  const handleCancelEditHistory = () => {
    setIsEditingHistory(false);
    setHistoryError(null);
  };

  // Roll the Incremental history slot back to the last snapshot taken before an
  // edit. Offered when the stored slot fails validation.
  const handleRestoreHistory = async () => {
    if (!remId) return;
    const backup = await plugin.storage.getSynced<HistoryBackup>(historyBackupKey(remId));
    if (!backup?.raw) {
      await plugin.app.toast('No restore point is available for this rem.');
      return;
    }
    const confirmed = confirm(
      `Restore the history captured before your last edit ` +
      `(${dayjs(backup.savedAt).format('MMM D, YYYY HH:mm')}, ${dayjs(backup.savedAt).fromNow()})?\n\n` +
      `This overwrites the current repHist slot.`
    );
    if (!confirmed) return;

    setIsSavingHistory(true);
    try {
      const targetRem = await plugin.rem.findOne(remId);
      if (!targetRem) {
        await plugin.app.toast('No rem found!');
        return;
      }
      await plugin.storage.setSession('plugin_updating_srs_data', true);
      try {
        await targetRem.setPowerupProperty(powerupCode, repHistorySlotCode, [backup.raw]);
      } finally {
        setTimeout(async () => {
          await plugin.storage.setSession('plugin_updating_srs_data', false);
        }, 3000);
      }

      const freshIncRem = await getIncrementalRemFromRem(plugin, targetRem);
      if (freshIncRem) {
        await updateIncrementalRemCache(plugin, freshIncRem);
      }

      await plugin.app.toast('Restored history from the last restore point.');
      setIsEditingHistory(false);
      setHistoryError(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      console.error('[EditHistory] Restore error:', e);
      await plugin.app.toast('Restore failed — check console.');
    } finally {
      setIsSavingHistory(false);
    }
  };

  // Persist a hand-edited Incremental history. Writes the edited JSON verbatim to
  // the `repHist` slot (debug-editor semantics: what you type is what is stored),
  // so you can fix reviewTimeSeconds, add/delete entries, etc. It intentionally
  // does NOT touch the Next Rep date.
  const handleSaveHistory = async () => {
    if (!remId) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(historyDraft);
    } catch (e) {
      setHistoryError(`Invalid JSON: ${String(e)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setHistoryError('History must be a JSON array of entries, e.g. [ { "date": 123, "scheduled": 123 } ].');
      return;
    }
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        setHistoryError(`Entry ${i} is not an object.`);
        return;
      }
    }

    setIsSavingHistory(true);
    try {
      const targetRem = await plugin.rem.findOne(remId);
      if (!targetRem) {
        await plugin.app.toast('No rem found!');
        return;
      }

      // Suppress the GlobalRemChanged manual-date-reset detection while we rewrite
      // the history slot (same flag + delayed-clear pattern as updateSRSDataForRem).
      await plugin.storage.setSession('plugin_updating_srs_data', true);
      try {
        await targetRem.setPowerupProperty(powerupCode, repHistorySlotCode, [JSON.stringify(parsed)]);
      } finally {
        setTimeout(async () => {
          await plugin.storage.setSession('plugin_updating_srs_data', false);
        }, 3000);
      }

      // Keep the session queue cache consistent with the edited history.
      const freshIncRem = await getIncrementalRemFromRem(plugin, targetRem);
      if (freshIncRem) {
        await updateIncrementalRemCache(plugin, freshIncRem);
      }

      await plugin.app.toast(`Saved history — ${parsed.length} entr${parsed.length === 1 ? 'y' : 'ies'}.`);
      setIsEditingHistory(false);
      setHistoryError(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      console.error('[EditHistory] Save error:', e);
      setHistoryError(`Save failed: ${String(e)}`);
    } finally {
      setIsSavingHistory(false);
    }
  };

  const handleDebugPDF = async () => {
    if (!remId) return;
    setIsPdfDebugging(true);
    try {
      const focusedRem = await plugin.rem.findOne(remId);
      if (!focusedRem) { await plugin.app.toast('No rem found!'); return; }

      // Resolve the actual PDF document rem: check the focused rem itself first,
      // then fall back to its sources for an UploadedFile rem.
      let rootRem = focusedRem;
      if (!(await focusedRem.hasPowerup(BuiltInPowerupCodes.UploadedFile))) {
        const sources = await focusedRem.getSources();
        const pdfSource = await Promise.all(
          sources.map(async (s: any) => ({ rem: s, isPdf: await s.hasPowerup(BuiltInPowerupCodes.UploadedFile) }))
        ).then(results => results.find(r => r.isPdf)?.rem ?? null);
        if (pdfSource) {
          rootRem = pdfSource;
          await plugin.app.toast(`Resolved PDF source: ${await safeRemTextToString(plugin, pdfSource.text)}`);
        }
      }

      // Probe EVERY built-in powerup (not a curated subset) so the dump reveals any
      // powerup that might still mark the canonical "Highlights" container — e.g.
      // Slot / Collection / List — even though isPowerupProperty() is deprecated.
      // BuiltInPowerupCodes is a runtime TS enum, so Object.entries yields
      // [name, code] pairs; append the plugin's own Incremental powerup.
      const POWERUP_LABELS: [string, string][] = [
        ...Object.entries(BuiltInPowerupCodes).map(([name, code]) => [name, code] as [string, string]),
        ['Incremental', powerupCode],
      ];

      interface RemNode {
        id: string;
        name: string;
        parentId: string | null;
        depth: number;
        powerups: string[];
        tags: string[];
        highlightData: string | null;
        pdfId: string | null;
      }

      const nodes: RemNode[] = [];
      const MAX_NODES = 600;

      const collectNodes = async (currentRem: any, depth: number, parentId: string | null) => {
        if (nodes.length >= MAX_NODES) return;

        const name = await safeRemTextToString(plugin, currentRem.text);

        const activePowerups: string[] = [];
        for (const [label, code] of POWERUP_LABELS) {
          try {
            if (await currentRem.hasPowerup(code)) activePowerups.push(label);
          } catch { /* some codes may not be queryable — skip */ }
        }

        const tagRems = await currentRem.getTagRems();
        const tags: string[] = await Promise.all(
          tagRems.map((t: any) => safeRemTextToString(plugin, t.text))
        );

        let highlightData: string | null = null;
        let pdfId: string | null = null;
        if (activePowerups.includes('PDFHighlight')) {
          try {
            const raw = await currentRem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data');
            highlightData = raw ? String(raw) : null;
          } catch { /* ignore */ }
          try {
            const pdfIdRichText = await currentRem.getPowerupPropertyAsRichText(
              BuiltInPowerupCodes.PDFHighlight,
              'PdfId'
            );
            pdfId = (pdfIdRichText?.[0] as RichTextElementRemInterface)?._id ?? null;
          } catch { /* ignore */ }
        }

        nodes.push({ id: currentRem._id, name, parentId, depth, powerups: activePowerups, tags, highlightData, pdfId });

        const children = await currentRem.getChildrenRem();
        for (const child of children) {
          await collectNodes(child, depth + 1, currentRem._id);
        }
      };

      await collectNodes(rootRem, 0, null);

      const indent = (depth: number) => '  '.repeat(depth);
      const treeLines: string[] = [];
      for (const node of nodes) {
        const pwStr = node.powerups.length ? ` [${node.powerups.join(', ')}]` : '';
        const tagStr = node.tags.length ? ` #tags:[${node.tags.join(', ')}]` : '';
        const dataStr = node.highlightData ? ` DATA:${node.highlightData.slice(0, 80)}` : '';
        const pdfIdStr = node.pdfId ? ` PdfId:${node.pdfId}` : (node.powerups.includes('PDFHighlight') ? ' PdfId:MISSING' : '');
        treeLines.push(`${indent(node.depth)}• "${node.name}" (${node.id})${pwStr}${tagStr}${dataStr}${pdfIdStr}`);
      }

      console.log(`\n========== PDF TREE DEBUG: "${await safeRemTextToString(plugin, rootRem.text)}" (${remId}) ==========`);
      console.log(`Total nodes collected: ${nodes.length}${nodes.length >= MAX_NODES ? ' (TRUNCATED at limit)' : ''}`);
      console.log('\n--- TREE VIEW ---');
      console.log(treeLines.join('\n'));
      console.log('\n--- RAW JSON ---');
      console.log(JSON.stringify(nodes, null, 2));
      console.log('===========================================\n');

      await plugin.app.toast(`PDF Debug: ${nodes.length} nodes logged to console. Open DevTools to inspect.`);
    } finally {
      setIsPdfDebugging(false);
    }
  };

  const handleRepairPDF = async () => {
    if (!remId) return;
    setIsRepairing(true);
    try {
      // Resolve PDF rem — same logic as handleDebugPDF
      const focusedRem = await plugin.rem.findOne(remId);
      if (!focusedRem) { await plugin.app.toast('No rem found!'); return; }

      let pdfRem: any = focusedRem;
      if (!(await focusedRem.hasPowerup(BuiltInPowerupCodes.UploadedFile))) {
        const sources = await focusedRem.getSources();
        const found = await Promise.all(
          sources.map(async (s: any) => ({ rem: s, isPdf: await s.hasPowerup(BuiltInPowerupCodes.UploadedFile) }))
        ).then(r => r.find(x => x.isPdf)?.rem ?? null);
        if (found) pdfRem = found;
      }

      const pdfName = await safeRemTextToString(plugin, pdfRem.text);
      const children: any[] = await pdfRem.getChildrenRem();

      // --- Classify direct children ---
      // Post-overhaul detection: RemNote's managed "Highlights" container can only
      // be identified by name + position (a direct child of the PDF/UploadedFile
      // rem). Tags, isProperty, isPowerupProperty and AutoSort no longer
      // distinguish it — the genuine container carries AutoSort exactly like the
      // PDF root does, so the old "PDF Highlight Section" tag / AutoSort heuristic
      // misfiled the real container as "broken".
      //   highlightsContainers = direct children literally named "Highlights"
      //   orphanedPages        = PDFPageNumber rems sitting directly under the PDF root
      const highlightsContainers: any[] = [];
      const orphanedPages: any[] = [];

      for (const child of children) {
        if (await child.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) {
          orphanedPages.push(child);
          continue;
        }
        const childName = await safeRemTextToString(plugin, child.text);
        if (childName === 'Highlights') highlightsContainers.push(child);
      }

      // Choose the container holding the most page nodes as canonical. Any extra
      // "Highlights" containers are stale duplicates whose pages we fold in.
      let canonicalContainer: any = null;
      const duplicateContainers: any[] = [];
      if (highlightsContainers.length > 0) {
        const withCounts = await Promise.all(
          highlightsContainers.map(async (c) => {
            const kids: any[] = await c.getChildrenRem();
            let pageCount = 0;
            for (const k of kids) {
              if (await k.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) pageCount++;
            }
            return { container: c, pageCount };
          })
        );
        withCounts.sort((a, b) => b.pageCount - a.pageCount);
        canonicalContainer = withCounts[0].container;
        for (let i = 1; i < withCounts.length; i++) duplicateContainers.push(withCounts[i].container);
      }

      // Pages sitting inside stale duplicate containers also need folding in.
      for (const dc of duplicateContainers) {
        const dcChildren: any[] = await dc.getChildrenRem();
        for (const c of dcChildren) {
          if (await c.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) orphanedPages.push(c);
        }
      }

      const allPagesToMove = orphanedPages;

      // --- PdfId diagnosis ---
      const allDescendants: any[] = await pdfRem.getDescendants();
      let wrongPdfIdCount = 0;
      for (const desc of allDescendants) {
        if (!(await desc.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) continue;
        try {
          const pdfIdRT = await desc.getPowerupPropertyAsRichText(BuiltInPowerupCodes.PDFHighlight, 'PdfId');
          const cur = (pdfIdRT?.[0] as RichTextElementRemInterface)?._id ?? null;
          if (cur !== pdfRem._id) wrongPdfIdCount++;
        } catch { /* skip */ }
      }

      const needsDocumentPowerup = !(await pdfRem.hasPowerup(BuiltInPowerupCodes.Document));

      // --- Build fix list ---
      const fixes: string[] = [];

      // Pages need to move but no canonical container yet — user must create a highlight first
      if (allPagesToMove.length > 0 && !canonicalContainer) {
        alert(
          `Cannot complete repair for "${pdfName}" yet.\n\n` +
          `Found ${allPagesToMove.length} page node(s) that need to be moved, but there is no canonical ` +
          `"Highlights" container (the one with the "PDF Highlight Section" tag). ` +
          `RemNote creates this automatically when you make your first highlight.\n\n` +
          `Workaround:\n` +
          `1. Open this PDF and make a single highlight anywhere.\n` +
          `2. Return here and click "Repair PDF" again.`
        );
        return;
      }

      if (allPagesToMove.length > 0) {
        fixes.push(`• Merge/move ${allPagesToMove.length} page node(s) into the canonical "Highlights" container (same-numbered pages are merged, emptied orphans deleted)`);
      }
      if (needsDocumentPowerup) {
        fixes.push('• Add Document powerup to PDF root');
      }
      if (wrongPdfIdCount > 0) {
        fixes.push(`• Fix PdfId slot on ${wrongPdfIdCount} highlight(s) (broken pin navigation)`);
      }

      if (fixes.length === 0) {
        await plugin.app.toast('Structure looks healthy — nothing to repair!');
        return;
      }

      const confirmed = confirm(
        `Repair highlights for "${pdfName}"?\n\n` +
        `Issues found:\n${fixes.join('\n')}\n\nContinue?`
      );
      if (!confirmed) return;

      // --- Execute: merge/move pages into the canonical container ---
      // Index the pages already inside the canonical container by normalized name
      // ("Page 05"). An orphan whose page number matches an existing page gets its
      // highlight children folded into that page and is then deleted; the rest are
      // re-parented whole.
      const normalizePageName = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const existingPages = new Map<string, any>();
      for (const existing of await canonicalContainer.getChildrenRem()) {
        if (await existing.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) {
          existingPages.set(normalizePageName(await safeRemTextToString(plugin, existing.text)), existing);
        }
      }

      let pagesReparented = 0;
      let pagesMerged = 0;
      let highlightsMoved = 0;
      for (const page of allPagesToMove) {
        if (page._id === canonicalContainer._id) continue; // never re-parent the container into itself
        const key = normalizePageName(await safeRemTextToString(plugin, page.text));
        const target = existingPages.get(key);
        if (target && target._id !== page._id) {
          // Merge: move this orphan's children into the existing page, delete orphan.
          const kids: any[] = await page.getChildrenRem();
          for (const kid of kids) {
            await kid.setParent(target._id);
            highlightsMoved++;
          }
          await page.remove();
          pagesMerged++;
          console.log(`[RepairPDF] Merged orphan "${key}" (${kids.length} child(ren)) into ${target._id}, deleted orphan ${page._id}`);
        } else {
          await page.setParent(canonicalContainer._id);
          existingPages.set(key, page); // subsequent same-numbered orphans merge into this one
          pagesReparented++;
          console.log(`[RepairPDF] Re-parented page "${key}" → canonical container`);
        }
      }

      // Remove any now-empty stale duplicate "Highlights" containers.
      let duplicatesRemoved = 0;
      for (const dc of duplicateContainers) {
        const remaining: any[] = await dc.getChildrenRem();
        let stillHasPages = false;
        for (const c of remaining) {
          if (await c.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) { stillHasPages = true; break; }
        }
        if (!stillHasPages) {
          try { await dc.remove(); duplicatesRemoved++; } catch { /* leave it if removal fails */ }
        }
      }

      // Add Document powerup to PDF root if missing
      if (needsDocumentPowerup) {
        await pdfRem.addPowerup(BuiltInPowerupCodes.Document);
      }
      // NOTE: AutoSort is RemNote's normal state on a PDF root (and on the
      // Highlights container) after the storage/sync overhaul — do NOT strip it.

      // --- Execute: fix PdfId slots ---
      let pdfIdFixed = 0;
      let pdfIdAlreadyCorrect = 0;
      const correctPdfIdSlot = [{ i: 'q' as const, _id: pdfRem._id }];

      for (const desc of allDescendants) {
        if (!(await desc.hasPowerup(BuiltInPowerupCodes.PDFHighlight))) continue;
        try {
          const pdfIdRichText = await desc.getPowerupPropertyAsRichText(BuiltInPowerupCodes.PDFHighlight, 'PdfId');
          const currentPdfId = (pdfIdRichText?.[0] as RichTextElementRemInterface)?._id ?? null;
          if (currentPdfId === pdfRem._id) {
            pdfIdAlreadyCorrect++;
          } else {
            await desc.setPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'PdfId', correctPdfIdSlot);
            pdfIdFixed++;
            console.log(`[RepairPDF] Fixed PdfId on ${desc._id}: was "${currentPdfId}" → "${pdfRem._id}"`);
          }
        } catch (e) {
          console.warn(`[RepairPDF] Could not fix PdfId on ${desc._id}:`, e);
        }
      }

      const parts: string[] = [];
      if (pagesReparented > 0) parts.push(`re-parented ${pagesReparented} page(s)`);
      if (pagesMerged > 0) parts.push(`merged ${pagesMerged} duplicate page(s) (${highlightsMoved} highlight(s) folded in)`);
      if (duplicatesRemoved > 0) parts.push(`removed ${duplicatesRemoved} empty duplicate container(s)`);
      if (needsDocumentPowerup) parts.push('added Document powerup');
      parts.push(`fixed ${pdfIdFixed} PdfId(s) (${pdfIdAlreadyCorrect} already correct)`);

      const msg = `Repair complete: ${parts.join(', ')}.`;
      await plugin.app.toast(msg);
      console.log(`[RepairPDF] ${msg}`);
    } catch (e) {
      console.error('[RepairPDF] Error:', e);
      await plugin.app.toast('Repair failed — check console for details.');
    } finally {
      setIsRepairing(false);
    }
  };

  const handleDumpPageHistory = async () => {
    if (!remId) return;
    setIsDumpingHistory(true);
    try {
      const focusedRem = await plugin.rem.findOne(remId);
      if (!focusedRem) {
        await plugin.app.toast('No rem found!');
        return;
      }

      const pdfs = await getAllPDFsInRem(plugin, focusedRem);
      if (pdfs.length === 0) {
        await plugin.app.toast('No PDF sources found on this rem.');
        return;
      }

      const perPdf: NonNullable<typeof pageHistoryDump>['perPdf'] = [];

      console.log(`\n========== PAGE HISTORY DUMP: ${remId} ==========`);
      for (const { rem: pdfRem } of pdfs) {
        const pdfName = await safeRemTextToString(plugin, pdfRem.text);
        // Reading state lives on the Rem now; the legacy key is only still read
        // here to show whether this pair has migrated. `null` next to a populated
        // parsed history means "migrated", not "data lost".
        const storageKey = getPageHistoryKey(remId, pdfRem._id);
        const legacyRaw = await plugin.storage.getSynced(storageKey);
        const parsed = await getPageHistory(plugin, remId, pdfRem._id);
        const stats = await getReadingStatistics(plugin, remId, pdfRem._id);

        const durations = parsed
          .map((e) => e.sessionDuration)
          .filter((d): d is number => typeof d === 'number' && d > 0);
        const durationsSum = durations.reduce((s, d) => s + d, 0);
        const durationsMin = durations.length ? Math.min(...durations) : null;
        const durationsMax = durations.length ? Math.max(...durations) : null;
        const capped14400Count = durations.filter((d) => d >= 14400).length;

        console.log(`\n--- PDF: "${pdfName}" (${pdfRem._id}) ---`);
        console.log(`Storage key: ${storageKey}`);
        console.log(`Entries: ${parsed.length}`);
        console.log(`Entries with sessionDuration > 0: ${durations.length}`);
        console.log(`Sum of sessionDurations: ${durationsSum}s = ${formatDuration(durationsSum)}`);
        console.log(`getReadingStatistics().totalTimeSeconds: ${stats.totalTimeSeconds}s = ${formatDuration(stats.totalTimeSeconds)}`);
        console.log(`Min duration: ${durationsMin}s   Max duration: ${durationsMax}s   Capped(>=14400): ${capped14400Count}`);
        console.log(
          `Legacy synced value (${legacyRaw == null ? 'none — migrated to the Rem' : 'still present'}):`,
          legacyRaw
        );
        console.log(`Parsed history (JSON):`);
        console.log(JSON.stringify(parsed, null, 2));

        perPdf.push({
          pdfRemId: pdfRem._id,
          pdfName,
          storageKey,
          total: stats.totalTimeSeconds,
          entryCount: parsed.length,
          durationsCount: durations.length,
          durationsSum,
          durationsMin,
          durationsMax,
          capped14400Count,
          raw: parsed,
        });
      }
      console.log(`===========================================\n`);

      setPageHistoryDump({ perPdf });
      await plugin.app.toast(`Dumped page history for ${pdfs.length} PDF(s) — see console + UI.`);
    } catch (e) {
      console.error('[DumpPageHistory] Error:', e);
      await plugin.app.toast('Dump failed — check console for details.');
    } finally {
      setIsDumpingHistory(false);
    }
  };

  const handleCleanDismissed = async () => {
    if (!remId) return;
    try {
      const focusedRem = await plugin.rem.findOne(remId);
      if (!focusedRem) { await plugin.app.toast('No rem found!'); return; }

      const hasPowerup = await focusedRem.hasPowerup(dismissedPowerupCode);
      if (!hasPowerup) {
        await plugin.app.toast('No dismissed powerup found!');
        return;
      }

      // Suppress GlobalRemChanged during the removal below. removePowerup fires a
      // GlobalRemChanged event; the listener pre-captures this rem's history (still
      // present in the allIncrementalRemKey session cache) and, seeing the powerup
      // gone with history in hand, calls transferToDismissed — which re-adds the
      // dismissed powerup a few seconds later. Setting plugin_operation_active makes
      // the listener skip this rem (same flag + delayed-clear pattern used by the
      // cloze command in commands.ts).
      await plugin.storage.setSession('plugin_operation_active', true);
      try {
        await focusedRem.setPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode, []);
        await focusedRem.setPowerupProperty(dismissedPowerupCode, dismissedDateSlotCode, []);
        await focusedRem.removePowerup(dismissedPowerupCode);

        await plugin.app.toast('Cleaned dismissed powerup and its slots!');
      } finally {
        // Clear after a delay longer than the GlobalRemChanged debounce (1000ms) so
        // any pending event from the removePowerup write is also suppressed.
        setTimeout(async () => {
          await plugin.storage.setSession('plugin_operation_active', false);
        }, 2000);
      }
    } catch (e) {
      console.error('[CleanDismissed] Error:', e);
      await plugin.app.toast('Failed to clean dismissed powerup.');
    }
  };

  // Cutoff: ae25eeb (2026-02-04) — the commit that started preserving
  // reviewTimeSeconds onto the Dismissed powerup's history. Before this
  // date, page-history sessionDuration is sometimes the only surviving
  // record of review time (rep history was lost on dismissal), so we must
  // not touch it.
  const PAGE_HISTORY_CLEANUP_CUTOFF_MS = Date.UTC(2026, 1, 4); // Feb 4 2026 UTC
  const TIMESTAMP_TOLERANCE_MS = 5000;
  const DURATION_TOLERANCE_S = 2;

  type InflationPdfEntry = NonNullable<typeof inflationPreview>['perPdf'][number];

  // Per (rem, pdf) analysis: returns null if there's nothing in storage for
  // this pair (no key). Uses repHistory (already resolved by the caller) to
  // decide which page-history entries are rep-aligned and which are inflated.
  const analyzeInflationForRemPdf = async (
    rId: string,
    pdfRem: any,
    pdfName: string,
    repHistory: Array<{ date: number; reviewTimeSeconds?: number }>
  ): Promise<InflationPdfEntry | null> => {
    // Page history now lives on the Rem, so a missing legacy key no longer means
    // "nothing recorded" — read through the accessor and treat an empty history
    // as nothing to analyse. storageKey is kept for display only.
    const storageKey = getPageHistoryKey(rId, pdfRem._id);
    const history = await getPageHistory(plugin, rId, pdfRem._id);
    if (history.length === 0) return null;

    const matchesRep = (entry: { timestamp: number; sessionDuration?: number }) => {
      const dur = entry.sessionDuration;
      if (typeof dur !== 'number') return false;
      return repHistory.some(r => {
        if (typeof r.reviewTimeSeconds !== 'number') return false;
        if (Math.abs(r.date - entry.timestamp) > TIMESTAMP_TOLERANCE_MS) return false;
        if (Math.abs(r.reviewTimeSeconds - dur) > DURATION_TOLERANCE_S) return false;
        return true;
      });
    };

    const preserved: InflationPdfEntry['preserved'] = [];
    const stripped: InflationPdfEntry['stripped'] = [];
    const beforeTotal = history.reduce((s, e) => s + (e.sessionDuration ?? 0), 0);

    const patched = history.map((entry, idx) => {
      if (typeof entry.sessionDuration !== 'number') return entry;
      if (entry.timestamp < PAGE_HISTORY_CLEANUP_CUTOFF_MS) {
        preserved.push({ index: idx, timestamp: entry.timestamp, sessionDuration: entry.sessionDuration, reason: 'before cutoff' });
        return entry;
      }
      if (matchesRep(entry)) {
        preserved.push({ index: idx, timestamp: entry.timestamp, sessionDuration: entry.sessionDuration, reason: 'matches rep' });
        return entry;
      }
      stripped.push({ index: idx, timestamp: entry.timestamp, sessionDuration: entry.sessionDuration, reason: 'no matching rep — inflated bookmark' });
      const { sessionDuration: _drop, ...rest } = entry as any;
      return rest;
    });

    const afterTotal = patched.reduce((s, e: any) => s + (e.sessionDuration ?? 0), 0);

    return {
      pdfRemId: pdfRem._id,
      pdfName,
      storageKey,
      stripCount: stripped.length,
      keptCount: preserved.length,
      strippedSecondsTotal: stripped.reduce((s, e) => s + e.sessionDuration, 0),
      keptSecondsTotal: preserved.reduce((s, e) => s + e.sessionDuration, 0),
      beforeTotalSeconds: beforeTotal,
      afterTotalSeconds: afterTotal,
      preserved,
      stripped,
      patched,
    };
  };

  const buildInflationPlan = async () => {
    if (!remId) return null;
    const focusedRem = await plugin.rem.findOne(remId);
    if (!focusedRem) return null;

    // Source of authoritative rep durations: active IncRem history first,
    // then Dismissed history (for already-dismissed rems like the one in
    // this report).
    const incRemInfo = await getIncrementalRemFromRem(plugin, focusedRem);
    const dismissedInfo = await getDismissedHistoryFromRem(plugin, focusedRem);
    const repHistory: Array<{ date: number; reviewTimeSeconds?: number }> =
      (incRemInfo?.history as any) ?? (dismissedInfo?.history as any) ?? [];

    const pdfs = await getAllPDFsInRem(plugin, focusedRem);
    if (pdfs.length === 0) return null;

    const perPdf: InflationPdfEntry[] = [];
    for (const { rem: pdfRem } of pdfs) {
      const pdfName = await safeRemTextToString(plugin, pdfRem.text);
      const entry = await analyzeInflationForRemPdf(remId, pdfRem, pdfName, repHistory);
      if (entry) perPdf.push(entry);
    }

    return { cutoffMs: PAGE_HISTORY_CLEANUP_CUTOFF_MS, perPdf };
  };

  const handlePreviewInflationCleanup = async () => {
    if (!remId) return;
    setIsCleaningInflation(true);
    try {
      const plan = await buildInflationPlan();
      if (!plan) {
        await plugin.app.toast('No PDF sources found on this rem.');
        return;
      }
      setInflationPreview(plan);

      console.log(`\n========== INFLATION CLEANUP PREVIEW: ${remId} ==========`);
      console.log(`Cutoff: ${new Date(plan.cutoffMs).toISOString().slice(0, 10)} UTC (${plan.cutoffMs})`);
      for (const p of plan.perPdf) {
        console.log(`\n--- ${p.pdfName} (${p.pdfRemId}) ---`);
        console.log(`Before total: ${p.beforeTotalSeconds}s   After total: ${p.afterTotalSeconds}s`);
        console.log(`Would strip ${p.stripCount} entr(ies) totaling ${p.strippedSecondsTotal}s`);
        console.log(`Would keep  ${p.keptCount} entr(ies) totaling ${p.keptSecondsTotal}s`);
        console.log('Preserved:', p.preserved);
        console.log('Stripped:', p.stripped);
      }
      console.log(`===========================================\n`);

      const totalStrip = plan.perPdf.reduce((s, p) => s + p.stripCount, 0);
      await plugin.app.toast(`Preview ready — ${totalStrip} entr(ies) would be stripped. Review then click Apply.`);
    } catch (e) {
      console.error('[InflationCleanup preview] Error:', e);
      await plugin.app.toast('Preview failed — check console.');
    } finally {
      setIsCleaningInflation(false);
    }
  };

  const handleApplyInflationCleanup = async () => {
    if (!inflationPreview) return;
    const totalStrip = inflationPreview.perPdf.reduce((s, p) => s + p.stripCount, 0);
    if (totalStrip === 0) {
      await plugin.app.toast('Nothing to strip.');
      return;
    }
    const summary = inflationPreview.perPdf
      .filter(p => p.stripCount > 0)
      .map(p => `• ${p.pdfName}: strip ${p.stripCount}, total ${formatDuration(p.beforeTotalSeconds)} → ${formatDuration(p.afterTotalSeconds)}`)
      .join('\n');
    const confirmed = confirm(
      `Apply inflation cleanup?\n\nThis will rewrite page-history storage for the following PDF(s):\n\n${summary}\n\nContinue?`
    );
    if (!confirmed) return;

    setIsCleaningInflation(true);
    try {
      for (const p of inflationPreview.perPdf) {
        if (p.stripCount === 0) continue;
        await setPageHistory(plugin, remId!, p.pdfRemId, p.patched);
        console.log(`[InflationCleanup] Rewrote page history for ${remId}/${p.pdfRemId} — stripped ${p.stripCount} entr(ies).`);
      }
      await plugin.app.toast(`Cleanup applied. Stripped ${totalStrip} entr(ies).`);
      setInflationPreview(null);
    } catch (e) {
      console.error('[InflationCleanup apply] Error:', e);
      await plugin.app.toast('Apply failed — check console.');
    } finally {
      setIsCleaningInflation(false);
    }
  };

  const handleGlobalPreviewInflationCleanup = async () => {
    setIsGlobalCleaning(true);
    setGlobalScanProgress('Resolving IncRem + Dismissed powerups…');
    try {
      const incPowerup = await plugin.powerup.getPowerupByCode(powerupCode);
      const dismPowerup = await plugin.powerup.getPowerupByCode(dismissedPowerupCode);
      const incRems = ((await incPowerup?.taggedRem()) || []) as any[];
      const dismRems = ((await dismPowerup?.taggedRem()) || []) as any[];

      const all: Array<{ rem: any; kind: 'incRem' | 'dismissed' }> = [
        ...incRems.map(r => ({ rem: r, kind: 'incRem' as const })),
        ...dismRems.map(r => ({ rem: r, kind: 'dismissed' as const })),
      ];

      console.log(`\n========== GLOBAL INFLATION CLEANUP SCAN ==========`);
      console.log(`Cutoff: ${new Date(PAGE_HISTORY_CLEANUP_CUTOFF_MS).toISOString().slice(0, 10)} UTC (${PAGE_HISTORY_CLEANUP_CUTOFF_MS})`);
      console.log(`Scanning ${incRems.length} IncRem + ${dismRems.length} Dismissed = ${all.length} rems total`);

      const perRem: NonNullable<typeof globalInflationPreview>['perRem'] = [];
      let scanned = 0;

      for (const { rem: r, kind } of all) {
        scanned++;
        if (scanned % 25 === 0 || scanned === all.length) {
          setGlobalScanProgress(`Scanning ${scanned}/${all.length} rems…`);
          await new Promise(resolve => setTimeout(resolve, 0)); // yield to UI
        }

        const pdfs = await getAllPDFsInRem(plugin, r);
        if (pdfs.length === 0) continue;

        // Resolve rep history for THIS rem (active or dismissed).
        let repHistory: Array<{ date: number; reviewTimeSeconds?: number }> = [];
        if (kind === 'incRem') {
          const info = await getIncrementalRemFromRem(plugin, r);
          repHistory = (info?.history as any) ?? [];
        } else {
          const info = await getDismissedHistoryFromRem(plugin, r);
          repHistory = (info?.history as any) ?? [];
        }

        const perPdf: NonNullable<typeof globalInflationPreview>['perRem'][number]['perPdf'] = [];
        for (const { rem: pdfRem } of pdfs) {
          const pdfName = await safeRemTextToString(plugin, pdfRem.text);
          const entry = await analyzeInflationForRemPdf(r._id, pdfRem, pdfName, repHistory);
          if (entry && entry.stripCount > 0) perPdf.push(entry);
        }

        if (perPdf.length > 0) {
          const remName = await safeRemTextToString(plugin, r.text);
          perRem.push({ remId: r._id, remName, remKind: kind, perPdf });
        }
      }

      const totalStripCount = perRem.reduce((s, r) => s + r.perPdf.reduce((s2, p) => s2 + p.stripCount, 0), 0);
      const totalStrippedSeconds = perRem.reduce((s, r) => s + r.perPdf.reduce((s2, p) => s2 + p.strippedSecondsTotal, 0), 0);

      console.log(`\nAffected rems: ${perRem.length}`);
      console.log(`Total entries to strip: ${totalStripCount} (${totalStrippedSeconds}s = ${formatDuration(totalStrippedSeconds)})`);
      for (const r of perRem) {
        console.log(`\n• [${r.remKind}] ${r.remName} (${r.remId})`);
        for (const p of r.perPdf) {
          console.log(`    📄 ${p.pdfName}: strip ${p.stripCount} (${formatDuration(p.strippedSecondsTotal)}), ${formatDuration(p.beforeTotalSeconds)} → ${formatDuration(p.afterTotalSeconds)}`);
        }
      }
      console.log(`===========================================\n`);

      setGlobalInflationPreview({
        cutoffMs: PAGE_HISTORY_CLEANUP_CUTOFF_MS,
        scannedRems: all.length,
        affectedRems: perRem.length,
        totalStripCount,
        totalStrippedSeconds,
        perRem,
      });
      setGlobalScanProgress('');
      await plugin.app.toast(`Scan complete — ${totalStripCount} entr(ies) across ${perRem.length} rem(s) would be stripped.`);
    } catch (e) {
      console.error('[GlobalInflationCleanup preview] Error:', e);
      await plugin.app.toast('Global scan failed — check console.');
      setGlobalScanProgress('');
    } finally {
      setIsGlobalCleaning(false);
    }
  };

  const handleGlobalApplyInflationCleanup = async () => {
    if (!globalInflationPreview) return;
    if (globalInflationPreview.totalStripCount === 0) {
      await plugin.app.toast('Nothing to strip.');
      return;
    }
    const confirmed = confirm(
      `Apply global inflation cleanup?\n\n` +
      `This will rewrite page-history storage for ${globalInflationPreview.perRem.length} rem(s), ` +
      `stripping ${globalInflationPreview.totalStripCount} entr(ies) ` +
      `(${formatDuration(globalInflationPreview.totalStrippedSeconds)} total inflated time).\n\nContinue?`
    );
    if (!confirmed) return;

    setIsGlobalCleaning(true);
    try {
      let rewritten = 0;
      for (const r of globalInflationPreview.perRem) {
        for (const p of r.perPdf) {
          await setPageHistory(plugin, r.remId, p.pdfRemId, p.patched);
          rewritten++;
          console.log(`[GlobalInflationCleanup] Rewrote page history for ${r.remId}/${p.pdfRemId} — stripped ${p.stripCount} entr(ies).`);
        }
      }
      await plugin.app.toast(`Global cleanup applied. Rewrote ${rewritten} key(s), stripped ${globalInflationPreview.totalStripCount} entr(ies).`);
      setGlobalInflationPreview(null);
    } catch (e) {
      console.error('[GlobalInflationCleanup apply] Error:', e);
      await plugin.app.toast('Global apply failed — check console.');
    } finally {
      setIsGlobalCleaning(false);
    }
  };

  const handleAuditSyncedKeys = async () => {
    setIsAuditingKeys(true);
    setKeyAudit(null);
    setNullTestReport(null);
    try {
      const result = await auditSyncedKeys(plugin, setKeyAuditProgress);
      setKeyAudit(result);
      setKeyAuditProgress('');
      await plugin.app.toast(
        `Audit done — ${result.occupied} named key(s) of ${result.cap}, ${formatBytes(result.totalBytes)} measured.`
      );
    } catch (e) {
      console.error('[KeyAudit] Scan failed', e);
      setKeyAuditProgress('');
      await plugin.app.toast('Key audit failed — check console.');
    } finally {
      setIsAuditingKeys(false);
    }
  };

  const handleProbeCapacity = async () => {
    setIsAuditingKeys(true);
    try {
      const report = await probeWriteCapacity(plugin);
      setCapacityReport(report);
      console.log('[KeyAudit] Capacity probe:', report);
      await plugin.app.toast(
        report.atCap ? 'At cap — no new synced key can be written.' : 'Free capacity — a new key was accepted.'
      );
    } finally {
      setIsAuditingKeys(false);
    }
  };

  const handleCalibrateLimit = async () => {
    const confirmed = confirm(
      'Find the real per-key size ceiling?\n\n' +
        'This writes a scratch key repeatedly, up to a few MB per attempt, until RemNote refuses it — ' +
        'roughly 30 large writes and the sync traffic that implies. It leaves one extra key behind ' +
        '(nulled at the end). Continue?'
    );
    if (!confirmed) return;
    setIsAuditingKeys(true);
    setLimitReport(null);
    try {
      const report = await calibratePerKeyLimit(plugin, setKeyAuditProgress);
      setLimitReport(report);
      setKeyAuditProgress('');
      await plugin.app.toast(
        report.unit === 'unknown' ? 'Calibration inconclusive — see console.' : report.verdict
      );
    } catch (e) {
      console.error('[KeyAudit] Calibration failed', e);
      setKeyAuditProgress('');
      await plugin.app.toast('Calibration failed — check console.');
    } finally {
      setIsAuditingKeys(false);
    }
  };

  const handleAnalyzeKey = async () => {
    const key = anatomyKey.trim();
    if (!key) return;
    setIsAuditingKeys(true);
    setAnatomy(null);
    try {
      const result = await analyzeArrayKey(plugin, key);
      setAnatomy(result);
      await plugin.app.toast(
        result.exists
          ? `${key}: ${result.entries} entries, worst case ${formatBytes(result.worst)}.`
          : `${key} is absent or null.`
      );
    } catch (e) {
      console.error('[KeyAudit] Key anatomy failed', e);
      await plugin.app.toast('Key anatomy failed — check console.');
    } finally {
      setIsAuditingKeys(false);
    }
  };

  const handleTestNullFreesSlot = async () => {
    const sacrificial = keyAudit?.disposable?.[0];
    if (!sacrificial) return;
    const confirmed = confirm(
      `Test whether setSynced(key, null) frees a slot?\n\n` +
      `This temporarily nulls a disposable backup key:\n  ${sacrificial}\n\n` +
      `Its value is dumped to the console first and restored afterwards. Continue?`
    );
    if (!confirmed) return;
    setIsAuditingKeys(true);
    try {
      const report = await testNullFreesSlot(plugin, sacrificial);
      setNullTestReport(report);
      console.log('[KeyAudit] null-frees-slot report:', report);
      await plugin.app.toast(
        report.nullFreesSlot === null
          ? 'Test inconclusive — see the steps in the panel.'
          : report.nullFreesSlot
            ? 'Nulling a key DOES free a slot.'
            : 'Nulling a key does NOT free a slot.'
      );
    } finally {
      setIsAuditingKeys(false);
    }
  };

  const handleCleanDescendants = async () => {
    if (!rem) return;
    await plugin.app.toast('Scanning descendants for cardPriority tags on non-flashcard Rems...');
    const candidates = await findNonFlashcardDescendantsWithCardPriority(plugin, rem);

    if (candidates.length === 0) {
      await plugin.app.toast('No non-flashcard descendants with cardPriority found.');
      return;
    }

    const CHUNK_SIZE = 20;
    let totalCleaned = 0;

    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      const chunk = candidates.slice(i, i + CHUNK_SIZE);
      const listString = chunk.map((r: any) => `- ${r.name}`).join('\n');
      const chunkMsg = candidates.length > CHUNK_SIZE
        ? ` (Batch ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(candidates.length / CHUNK_SIZE)})`
        : '';

      const confirmed = confirm(
        `Found ${candidates.length} descendant Rem(s) with cardPriority but no flashcards.\n\n` +
        `This will remove the cardPriority powerup (and its slots) from ${chunk.length} of them${chunkMsg}:\n\n` +
        `${listString}\n\nContinue?`
      );

      if (!confirmed) {
        if (totalCleaned > 0) {
          await plugin.app.toast(`Aborted. Cleaned ${totalCleaned} descendant(s) total.`);
        }
        return;
      }

      await plugin.app.toast(`Cleaning ${chunk.length} descendant(s)...`);
      const result = await removeCardPriorityFromSpecificRems(plugin, chunk.map((r: any) => r.id));
      if (result.success) {
        totalCleaned += result.cleanedCount;
        setRefreshKey(k => k + 1);
      } else {
        await plugin.app.toast('Cleanup failed during batch. Check console.');
        return;
      }
    }

    await plugin.app.toast(`Done! Cleaned ${totalCleaned} non-flashcard descendant(s).`);
  };

  const handleSanitize = async () => {
    if (!rem) return;
    await plugin.app.toast('Scanning this rem + descendants for rogue CardPriority tags...');
    // Same authoritative (card-index based) detection as the global command,
    // scoped to this subtree. The old getSpuriousCardPriorityTags path matched
    // only slot-definition references and never caught these rogue nodes.
    const { rogueNoCard, preservedAnchors } = await findRogueCardPriorityRemsInSubtree(plugin, rem);

    if (preservedAnchors.length > 0) {
      console.log('[Sanitize] Preserved manual/incremental anchors (not touched):', preservedAnchors);
    }

    if (rogueNoCard.length === 0) {
      await plugin.app.toast(
        preservedAnchors.length > 0
          ? `No rogue tags found. (${preservedAnchors.length} manual/incremental anchor(s) preserved.)`
          : 'No rogue tags found in this rem or its descendants.'
      );
      return;
    }

    let totalCleaned = 0;
    const CHUNK_SIZE = 20;

    if (rogueNoCard.length > 0) {
      for (let i = 0; i < rogueNoCard.length; i += CHUNK_SIZE) {
        const chunk = rogueNoCard.slice(i, i + CHUNK_SIZE);
        const listString = chunk.map((r: any) => `- ${r.name}`).join('\n');

        const chunkMsg = rogueNoCard.length > CHUNK_SIZE
          ? `(Batch ${Math.floor(i/CHUNK_SIZE) + 1} of ${Math.ceil(rogueNoCard.length/CHUNK_SIZE)})`
          : '';

        const confirmed = confirm(`Found ${rogueNoCard.length} ROGUE CardPriority tag(s) on rems with NO flashcards (inherited/default source — manual & incremental anchors are kept). This will remove the powerup from ${chunk.length} of them ${chunkMsg}:\n\n${listString}\n\nContinue?`);

        if (!confirmed) {
          if (totalCleaned > 0) await plugin.app.toast(`Sanitize aborted. Cleaned ${totalCleaned} rogue tags total.`);
          return;
        }

        await plugin.app.toast(`Stripping ${chunk.length} rogue tag(s)...`);
        const result = await removeCardPriorityFromSpecificRems(plugin, chunk.map((r: any) => r.id));
        if (result.success) {
          totalCleaned += result.cleanedCount;
          setRefreshKey(k => k + 1);
        } else {
          await plugin.app.toast('Sanitize failed during batch. Check console.');
          return;
        }
      }
    }

    // Manual/incremental card-less anchors are legitimate and intentionally NOT
    // offered for deletion here (only reported to the console above). Use the
    // per-rem "Clear Card Priority" control to remove one deliberately.
    const anchorNote = preservedAnchors.length > 0
      ? ` (${preservedAnchors.length} manual/incremental anchor(s) preserved)`
      : '';
    await plugin.app.toast(`Sanitized! Cleaned ${totalCleaned} rogue tag(s) total${anchorNote}.`);
  };

  const handleScrubPowerup = async () => {
    if (!rem) return;
    const proceed = confirm('This will delete all CardPriority property slots on this Rem and remove the powerup.\n\nBecause this Rem has flashcards, the plugin will automatically recreate the powerup cleanly in a few seconds. Use this to fix duplicate slots.\n\nContinue?');
    if (!proceed) return;

    await plugin.app.toast('Scrubbing CardPriority data...');
    const result = await removeCardPriorityFromRem(plugin, rem);
    if (result.success) {
      await plugin.app.toast('Successfully scrubbed CardPriority. It should rebuild automatically soon.');
      setRefreshKey(k => k + 1);
    } else {
      await plugin.app.toast('Failed to scrub CardPriority. Check console.');
    }
  };

  const handleDumpStructure = async () => {
    if (!rem) return;
    await plugin.app.toast('Dumping slot/card structure to console...');
    const rows = await dumpRemPriorityStructure(plugin, rem);
    const rogue = rows.filter((r) => r.classification === 'rogue-no-card');
    const anchors = rows.filter((r) => r.classification === 'inheritance-anchor');
    await plugin.app.toast(
      `Structure dumped: ${rows.length} node(s), ${rogue.length} rogue (no-card), ${anchors.length} manual anchor(s). See console (console.table).`
    );
  };

  // Powerup READ-PATH diagnostic. The export-file comparison proved the values are
  // present and untouched in the target KB, so the remaining question is why
  // getPowerupProperty() cannot see them. Covers BOTH powerups. Read-only.
  const handleDiagnoseReadPath = async () => {
    if (!rem) return;
    await plugin.app.toast('Probing powerup read path...');
    const report = await diagnosePowerupReadPath(plugin, rem);
    const broken = report.powerups.filter((p) => p.verdict.startsWith('BROKEN'));
    const mismatch = report.powerups.some((p) => p.verdict.includes('IDENTITY MISMATCH'));
    if (broken.length === 0) {
      await plugin.app.toast('Read path OK for both powerups. See console.');
    } else {
      await plugin.app.toast(
        `${broken.length} powerup(s) unreadable` +
        (mismatch ? ' — powerup IDENTITY MISMATCH found.' : '.') +
        ' See console.'
      );
    }
  };

  // RAW slot dump — evidence for the RemNote support ticket about IncRems whose
  // priority reverted to 10. The "Priority" row above shows the value AFTER
  // getIncrementalRemFromRem's `let priority = 10` fallback, so it cannot tell a
  // stored 10 from an unreadable slot. This bypasses getPowerupProperty and reads
  // the property rems directly, for this rem and every descendant. Read-only.
  const handleDumpRawSlots = async () => {
    if (!rem) return;
    await plugin.app.toast('Dumping raw powerup slots (rem + descendants)...');
    try {
      const report = await dumpRawPowerupSlots(plugin, rem);
      const json = JSON.stringify(report, null, 2);
      setRawSlotDumpText(json);

      let copied = false;
      try {
        await navigator.clipboard.writeText(json);
        copied = true;
      } catch { /* clipboard is often blocked inside the plugin iframe */ }

      let downloaded = false;
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `raw-slot-dump-${dayjs().format('YYYY-MM-DD-HHmmss')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        downloaded = true;
      } catch (e) {
        console.warn('[RawSlotDump] File download failed (iframe sandbox?):', e);
      }

      await plugin.app.toast(
        `Raw dump: ${report.scannedRems} rem(s), ${report.properties.length} propert(ies), ` +
        `${report.unreachable.length} unreadable. ` +
        `${downloaded ? 'JSON downloaded. ' : ''}${copied ? 'Copied. ' : ''}See console.`
      );
    } catch (e) {
      console.error('[RawSlotDump] Error:', e);
      await plugin.app.toast('Raw slot dump failed — check console.');
    }
  };

  // KB-wide sizing scan for the two post-overhaul slot defects. "Dump Raw Slots"
  // explains ONE rem exhaustively; this counts how many are affected across the
  // whole knowledge base, for both priority powerups, and breaks the dangling
  // Daily Document references down by scheduling interval. Read-only, but it
  // walks every tagged rem — hence the progress state and the explicit run button.
  const handleScanKb = async () => {
    setIsScanningKb(true);
    setScanProgress('Gathering powerup populations…');
    try {
      const report = await scanKbForDetachedSlots(plugin, (done, total, phase) => {
        setScanProgress(`${phase}: ${done} / ${total}`);
      });
      setKbScan(report);
      const json = JSON.stringify(report, null, 2);
      setRawSlotDumpText(json);

      let copied = false;
      try {
        await navigator.clipboard.writeText(json);
        copied = true;
      } catch { /* clipboard is often blocked inside the plugin iframe */ }

      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `slot-damage-scan-${dayjs().format('YYYY-MM-DD-HHmmss')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) {
        console.warn('[SlotScan] File download failed (iframe sandbox?):', e);
      }

      await plugin.app.toast(
        `Scan done: Incremental ${report.incremental.detachedPct}% detached, ` +
        `CardPriority ${report.cardPriority.detachedPct}% detached, ` +
        `dates ${report.nextRepDate.danglingPct}% dangling. ${copied ? 'Copied. ' : ''}See console.`
      );
    } catch (e) {
      console.error('[SlotScan] Error:', e);
      await plugin.app.toast('KB scan failed — check console.');
    } finally {
      setIsScanningKb(false);
      setScanProgress(null);
    }
  };

  // CardPriority repair. CardPriority is repaired before Incremental because it
  // is the unmitigated case: getIncrementalRemFromRem recovers a detached
  // priority from the Rem's history, getCardPriority has nothing to fall back on
  // and silently serves an inherited value or the default instead.
  //
  // `limit` caps a live run so the first one can be small and inspected. The
  // orphaned property Rems are deliberately NOT deleted here — see
  // handleTestOrphanDeletion.
  const runCardPriorityRepair = async (dryRun: boolean, limit?: number) => {
    setIsRepairingCP(true);
    setRepairProgress(dryRun ? 'Scanning…' : 'Repairing…');
    try {
      const report = await repairDetachedCardPriorities(plugin, {
        dryRun,
        limit,
        onProgress: (done, total) => setRepairProgress(`${done} / ${total} Rems`),
      });
      setRepairReport(report);
      setRawSlotDumpText(JSON.stringify(report, null, 2));
      await plugin.app.toast(
        dryRun
          ? `Dry run: ${report.candidates} repairable, ${report.skippedDerivable} skipped as derivable. Nothing written.`
          : `Repaired ${report.repaired}${report.failedVerification ? `, ${report.failedVerification} FAILED verification` : ''}. See console.`
      );
    } catch (e: any) {
      console.error('[CPRepair] Error:', e);
      await plugin.app.toast(`Repair failed: ${e?.message ?? e}`);
    } finally {
      setIsRepairingCP(false);
      setRepairProgress(null);
    }
  };

  const handleRepairLive = async (limit?: number) => {
    const n = limit ?? repairReport?.candidates ?? 0;
    const confirmed = confirm(
      `This will WRITE to ${limit ? `up to ${limit}` : `all ${n}`} Rem(s), restoring each one's ` +
      `stranded card priority through the normal write path.\n\n` +
      `It does NOT delete the old detached property — each repaired Rem will keep a stray ` +
      `"Unnamed — N" row until the deletion step is verified separately.\n\n` +
      `Run a dry run first if you have not. Continue?`
    );
    if (!confirmed) return;
    await runCardPriorityRepair(false, limit);
  };

  // Staged deletion test. Deliberately tiny and separate: this is the one action
  // in the whole diagnostic set that destroys data, so it must never be first
  // attempted as part of a bulk pass. It refuses any Rem whose repaired priority
  // is not already readable, and reports the owner's state either side.
  const handleTestOrphanDeletion = async () => {
    if (!repairReport) {
      await plugin.app.toast('Run the repair first (a dry run is enough) so the orphan list exists.');
      return;
    }
    // A dry run is sufficient when the targets are DERIVABLE orphans: that list
    // is produced by the scan and does not depend on anything having been
    // written. Only the repaired-manual targets require a live run first, since
    // their safety depends on the value already being restored.
    const derivableAvailable = (repairReport.derivableOrphanPropertyRemIds ?? []).length > 0;
    if (repairReport.dryRun && !derivableAvailable) {
      await plugin.app.toast(
        'That report is a dry run and recorded no derivable orphans. Run the live repair first.'
      );
      return;
    }
    // Target only leftovers whose owner's slot ALREADY READS. The scan's
    // safe-to-delete list is the authority: it is computed from current state, so
    // it grows automatically once "Update all inherited Card Priorities" or a
    // repair has materialised the values. Falling back to the repair's own output
    // covers the case where no scan has been run this session.
    const ids = (kbScan?.safeToDeleteAll ?? []).map((l) => l.propertyRemId);
    if (!ids.length) ids.push(...repairReport.orphanPropertyRemIds);
    if (!ids.length) {
      await plugin.app.toast(
        'No repaired Rems recorded. Run the repair (with "incl. inherited" if you want the ' +
        'derivable ones fixed too) — the deletion only touches Rems whose value is already restored.'
      );
      return;
    }
    const confirmed = confirm(
      `This DELETES 3 orphaned property Rems (of ${ids.length} recorded).\n\n` +
      `Targets Rems this repair just restored, so the value already exists in the correct ` +
      `property. Any Rem whose slot is still empty is REFUSED automatically — its orphan ` +
      `would be the only copy.\n\n` +
      `The value each orphan held is captured first and printed, so it can be restored by hand.\n\n` +
      `Purpose: find out whether deleting the stale property disturbs the good one, BEFORE ` +
      `any bulk cleanup. Continue?`
    );
    if (!confirmed) return;

    await plugin.app.toast('Deleting 3 orphan property Rems…');
    const probes = await testDeleteOrphanProperties(plugin, ids, 3);
    setDeletionProbes(probes);
    const bad = probes.filter((p) => p.verdict.startsWith('DANGER'));
    await plugin.app.toast(
      bad.length
        ? `⚠ ${bad.length} deletion(s) disturbed the good value — DO NOT bulk clean. See console.`
        : `Deleted ${probes.filter((p) => p.deleted).length}. Priorities intact. See console.`
    );
  };

  // Bulk cleanup. Same per-Rem guard as the 3-Rem test — it is literally the same
  // function with the cap lifted — plus an abort on the first DANGER so one bad
  // deletion cannot become hundreds.
  const handleBulkOrphanDeletion = async () => {
    // Only Rems this repair restored. Un-repaired ones would be refused per-Rem
    // anyway, but there is no reason to attempt them: their orphan is still the
    // only materialised copy of the value.
    const ids = (kbScan?.safeToDeleteAll ?? []).map((l) => l.propertyRemId);
    if (!ids.length) ids.push(...(repairReport?.orphanPropertyRemIds ?? []));
    if (!ids.length) {
      await plugin.app.toast(
        'Nothing safe to delete. Run the KB scan — only leftovers whose owner Rem already ' +
        'reads a priority are eligible.'
      );
      return;
    }
    const confirmed = confirm(
      `DELETE ALL ${ids.length} orphan property Rems belonging to Rems this repair restored.\n\n` +
      `Run the 3-Rem test first and confirm it reported OK — this is the same code ` +
      `with the cap removed.\n\n` +
      `Each Rem is still checked individually: one is only deleted if its priority slot ` +
      `already reads back, and the whole run aborts on the first DANGER.\n\n` +
      `This cannot be undone. Continue?`
    );
    if (!confirmed) return;

    setIsRepairingCP(true);
    setRepairProgress('Deleting orphans…');
    try {
      const probes = await testDeleteOrphanProperties(plugin, ids, ids.length, (done, total) =>
        setRepairProgress(`Deleting ${done} / ${total}`)
      );
      setDeletionProbes(probes.filter((p) => !p.verdict.startsWith('OK')).slice(0, 20));
      const deleted = probes.filter((p) => p.deleted).length;
      const bad = probes.filter((p) => p.verdict.startsWith('DANGER')).length;
      await plugin.app.toast(
        bad
          ? `⚠ ABORTED after ${bad} DANGER — ${deleted} deleted. See console.`
          : `Deleted ${deleted} orphan propert(ies). See console.`
      );
    } catch (e: any) {
      console.error('[OrphanCleanup] Error:', e);
      await plugin.app.toast(`Cleanup failed: ${e?.message ?? e}`);
    } finally {
      setIsRepairingCP(false);
      setRepairProgress(null);
    }
  };

  // Cross-KB import diagnostic. Answers ONE question: after importing rems from
  // another KB and finding their manual priorities replaced by the default, is the
  // original value still physically present (attached to the imported KB's own
  // CardPriority powerup, which getPowerupByCode can't reach), or did it never
  // arrive? Read-only — it decides whether a recovery pass is worth writing.
  const handleScanImportedPriorities = async () => {
    if (!rem) return;
    await plugin.app.toast('Scanning for imported (orphaned) card priorities...');
    const result = await findOrphanedImportedCardPriorities(plugin, rem, true);
    const recoverable = result.nodes.filter((n) => n.recoverable).length;
    if (result.nodes.length === 0) {
      await plugin.app.toast(
        'No orphaned priority values found — the values likely did not survive the export. See console.'
      );
    } else {
      await plugin.app.toast(
        `Found ${result.nodes.length} rem(s) with priorities on ${result.foreignPowerups.length} foreign ` +
        `CardPriority powerup(s); ${recoverable} recoverable. See console (console.table).`
      );
    }
  };

  // KB-wide audit that answers: does `getPowerupByCode('cardPriority').taggedRem()`
  // match reality? "Remove All CardPriority Tags" and the cache both enumerate via
  // taggedRem(), yet it can return far fewer rems than are actually tagged. This
  // cross-checks taggedRem() against a DIRECT hasPowerup('cardPriority') probe over
  // every card-bearing rem, and also flags rems that carry a priority slot value
  // but no powerup tag (the write-side / slot-vs-tag decoupling signature).
  const handleTagAudit = async () => {
    setIsAuditingTags(true);
    try {
      console.log('\n========== CARDPRIORITY TAG AUDIT ==========');

      // A — taggedRem()
      const powerup = await plugin.powerup.getPowerupByCode('cardPriority');
      const taggedRems = (await powerup?.taggedRem()) || [];
      const taggedIds = new Set(taggedRems.map((r: any) => r._id));
      console.log(`taggedRem() → ${taggedRems.length} rems (powerup _id=${powerup?._id ?? '(none)'})`);

      // B — every unique card-bearing rem, probed directly
      const allCards = (await plugin.card.getAll()) || [];
      const cardRemIds = Array.from(new Set(allCards.map((c: Card) => c.remId).filter(Boolean))) as string[];
      console.log(`card.getAll() → ${allCards.length} cards across ${cardRemIds.length} rems. Probing hasPowerup directly…`);

      const canonicalDefId = powerup?._id ?? null;

      let hasPowerupCount = 0;
      let inTaggedRemCount = 0;
      let powerupNotInTaggedRem = 0;
      let slotButNoPowerup = 0;
      const sampleDivergent: string[] = [];

      // Which cardPriority powerup-DEFINITION rem each tagged rem points to.
      // Duplicate definitions (e.g. imported cross-KB) show up as >1 distinct id.
      const defIdCounts = new Map<string, number>();
      let unknownDefCount = 0;
      const bumpDef = (id: string) => defIdCounts.set(id, (defIdCounts.get(id) || 0) + 1);

      // Resolve the cardPriority definition rem a given rem is tagged with, by
      // scanning its tags for the one named "CardPriority". Returns null if none
      // is found on the tags.
      const resolveCardPriorityDefId = async (r: any): Promise<string | null> => {
        try {
          const tags = await r.getTagRems();
          for (const t of tags) {
            const nm = (await safeRemTextToString(plugin, t.text))?.trim();
            if (nm === 'CardPriority') return t._id;
          }
        } catch { /* ignore */ }
        return null;
      };

      const batchSize = 50;
      for (let i = 0; i < cardRemIds.length; i += batchSize) {
        const batch = cardRemIds.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (rid) => {
            const r = await plugin.rem.findOne(rid);
            if (!r) return;
            const has = await r.hasPowerup('cardPriority');
            const inTagged = taggedIds.has(rid);
            let slotVal: any = null;
            try { slotVal = await r.getPowerupProperty('cardPriority', 'priority'); } catch { /* ignore */ }
            const hasSlotValue = slotVal != null && String(slotVal).trim() !== '';

            if (has) hasPowerupCount++;
            if (inTagged) {
              inTaggedRemCount++;
              // Tagged rems are, by definition, tagged to the canonical def.
              if (canonicalDefId) bumpDef(canonicalDefId);
            }
            if (has && !inTagged) {
              powerupNotInTaggedRem++;
              const defId = await resolveCardPriorityDefId(r);
              if (defId) bumpDef(defId); else unknownDefCount++;
              if (sampleDivergent.length < 20)
                sampleDivergent.push(`${rid}: hasPowerup=true, taggedRem=MISSING, def=${defId ?? 'unknown'}, prioritySlot=${hasSlotValue ? String(slotVal) : '∅'}`);
            }
            if (!has && hasSlotValue) {
              slotButNoPowerup++;
              if (sampleDivergent.length < 20)
                sampleDivergent.push(`${rid}: hasPowerup=FALSE but prioritySlot=${String(slotVal)} ← slot without tag`);
            }
          })
        );
        if (i % (batchSize * 10) === 0) {
          console.log(`  …audited ${Math.min(i + batchSize, cardRemIds.length)}/${cardRemIds.length}`);
        }
      }

      const distinctDefs = Array.from(defIdCounts.entries())
        .map(([defId, count]) => ({ defId, count, isCanonical: defId === canonicalDefId }))
        .sort((a, b) => b.count - a.count);

      // Verdict
      let verdict: string;
      if (distinctDefs.length > 1) {
        verdict = `DUPLICATE DEFINITIONS: ${distinctDefs.length} distinct cardPriority powerup-definition rems tag these rems (getPowerupByCode returns only the canonical one, so taggedRem() misses those tagged to the other[s]). Typical cause: a document imported from another KB brought its own copy of the powerup.`;
      } else if (powerupNotInTaggedRem > 0 && hasPowerupCount > taggedRems.length) {
        verdict = `READ-SIDE: ${powerupNotInTaggedRem} rems have the cardPriority powerup but taggedRem() omits them, yet only ONE definition rem was found — points to a stale per-KB taggedRem index rather than duplicate definitions.`;
      } else if (slotButNoPowerup > 0) {
        verdict = `WRITE-SIDE: ${slotButNoPowerup} rems carry a priority slot value with NO cardPriority powerup tag → addPowerup did not persist the tag.`;
      } else if (hasPowerupCount === inTaggedRemCount) {
        verdict = 'CONSISTENT: taggedRem() matches direct hasPowerup over all card rems — no divergence.';
      } else {
        verdict = 'MIXED / inconclusive — inspect the counts and sample below.';
      }

      const result = {
        taggedRemCount: taggedRems.length,
        cardRemCount: cardRemIds.length,
        hasPowerupCount,
        inTaggedRemCount,
        powerupNotInTaggedRem,
        slotButNoPowerup,
        canonicalDefId,
        distinctDefs,
        unknownDefCount,
        verdict,
        sampleDivergent,
      };

      console.log('Summary:', result);
      console.log(`Distinct cardPriority definition rems (${distinctDefs.length}):`);
      distinctDefs.forEach((d) => console.log(`  • ${d.defId}${d.isCanonical ? ' (canonical, from getPowerupByCode)' : ' (DUPLICATE)'} — ${d.count} rems`));
      if (unknownDefCount > 0) console.log(`  • unresolved def on ${unknownDefCount} rem(s)`);
      console.log('Sample divergent rems:');
      sampleDivergent.forEach((s) => console.log('  •', s));
      console.log('VERDICT:', verdict);
      console.log('===========================================\n');

      setTagAudit(result);
      await plugin.app.toast(
        `Tag audit: taggedRem=${taggedRems.length}, hasPowerup=${hasPowerupCount}/${cardRemIds.length}. See console + panel for the verdict.`
      );
    } catch (e) {
      console.error('[TagAudit] Error:', e);
      await plugin.app.toast('Tag audit failed — check console.');
    } finally {
      setIsAuditingTags(false);
    }
  };

  // ------------------------------------------------------------------
  // Search / Linkage diagnostics
  // ------------------------------------------------------------------
  // Purpose: figure out why a rem with visible text (e.g. a "Concept ↔
  // definition" flashcard) cannot be found when typing its name in the
  // reference search. RemNote's reference search matches a rem's OWN literal,
  // normalized text tokens — so a rem can be invisible for reasons that never
  // show up in the rendered text. This probe gathers every search/linkage
  // relevant signal AND reproduces the search programmatically via
  // plugin.search.search(), so a sound rem and a flawed rem can be compared
  // side by side.
  const codePointOf = (ch: string): string =>
    'U+' + (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');

  const SUSPICIOUS_CHARS: Record<string, string> = {
    ' ': 'NO-BREAK SPACE',
    '​': 'ZERO WIDTH SPACE',
    '‌': 'ZERO WIDTH NON-JOINER',
    '‍': 'ZERO WIDTH JOINER',
    '\u200E': 'LEFT-TO-RIGHT MARK',
    '\u200F': 'RIGHT-TO-LEFT MARK',
    '\u202A': 'LEFT-TO-RIGHT EMBEDDING',
    '\u202B': 'RIGHT-TO-LEFT EMBEDDING',
    '\u202C': 'POP DIRECTIONAL FORMATTING',
    '\u202D': 'LEFT-TO-RIGHT OVERRIDE',
    '\u202E': 'RIGHT-TO-LEFT OVERRIDE',
    '⁠': 'WORD JOINER',
    '﻿': 'ZERO WIDTH NO-BREAK SPACE (BOM)',
  };

  // Dumps every shield-history synced key + the live write-side inputs, so we can
  // tell whether the Card shield history was lost, orphaned under a stale KB id,
  // or simply never written because the cardPriority cache is coming back empty.
  // Prints a full report to the console and exports the raw JSON (clipboard +
  // best-effort file download) so it can be shared without truncation.
  const handleDumpShieldHistory = async () => {
    setIsDumpingShield(true);
    try {
      const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
      const currentKbId = kbData?._id || 'global';
      const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();

      const storeDefs: Array<{ key: string; label: string; level: 'kb' | 'doc' }> = [
        { key: priorityShieldHistoryKey, label: 'IncRem Shield (KB)', level: 'kb' },
        { key: cardPriorityShieldHistoryKey, label: 'Card Shield (KB)', level: 'kb' },
        { key: documentPriorityShieldHistoryKey, label: 'IncRem Shield (Doc)', level: 'doc' },
        { key: documentCardPriorityShieldHistoryKey, label: 'Card Shield (Doc)', level: 'doc' },
      ];

      const rawByKey: Record<string, any> = {};
      const stores: ShieldStoreAnalysis[] = [];
      for (const def of storeDefs) {
        const raw = await plugin.storage.getSynced(def.key);
        rawByKey[def.key] = raw ?? null;
        stores.push(analyzeShieldStore(def.key, def.label, def.level, raw, currentKbId, isPrimary));
      }

      // Serialized size of each key — the "Diff too large to sync" limit is per
      // storage object, so an oversized key is the prime suspect for a stuck sync.
      const keySizes = storeDefs.map((def) => {
        const chars = rawByKey[def.key] == null ? 0 : JSON.stringify(rawByKey[def.key]).length;
        return { key: def.key, label: def.label, chars, approxKB: Math.round((chars / 1024) * 10) / 10 };
      }).sort((a, b) => b.chars - a.chars);

      // Live write-side probe — what QueueExit would have to work with right now.
      const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
      const allIncRems = (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
      const seenCardIds = (await plugin.storage.getSession<string[]>(seenCardInSessionKey)) || [];
      const seenRemIds = (await plugin.storage.getSession<string[]>(seenRemInSessionKey)) || [];
      const cardCacheLoaded = await plugin.storage.getSession<boolean>('card_priority_cache_fully_loaded');
      const incRemCacheLoaded = await plugin.storage.getSession<boolean>('inc_rem_cache_fully_loaded');

      let cardPriorityTaggedRems = 0;
      try {
        const cpPowerup = await plugin.powerup.getPowerupByCode('cardPriority');
        cardPriorityTaggedRems = ((await cpPowerup?.taggedRem()) || []).length;
      } catch (e) {
        console.warn('[ShieldDump] cardPriority taggedRem() probe failed:', e);
      }

      const live = {
        allCardInfos: allCardInfos.length,
        cardInfosWithPriority: allCardInfos.filter((c) => typeof c.priority === 'number').length,
        cardInfosWithDueOverdue: allCardInfos.filter((c) => c.dueCardsOverdue !== undefined).length,
        cardInfosDueOverdue: allCardInfos.filter((c) => (c.dueCardsOverdue ?? 0) > 0).length,
        allIncRems: allIncRems.length,
        cardPriorityTaggedRems,
        cardCacheLoaded: cardCacheLoaded ?? null,
        incRemCacheLoaded: incRemCacheLoaded ?? null,
        seenCardIds: seenCardIds.length,
        seenRemIds: seenRemIds.length,
      };

      // ---- Console report ----
      console.log('\n========== SHIELD HISTORY DUMP ==========');
      console.log('Current KB id:', currentKbId, '| isPrimary:', isPrimary);
      console.log('\n--- Stored shield histories ---');
      for (const s of stores) {
        console.log(
          `\n[${s.label}] key="${s.key}" (${s.level})\n` +
          `  status: ${s.status.toUpperCase()}\n` +
          `  ${s.verdict}\n` +
          `  top-level keys: ${s.topLevelKeys.length ? s.topLevelKeys.join(', ') : '(none)'}\n` +
          `  current-KB entries: ${s.currentKbDatedEntries}` +
          (s.currentKbScopes !== undefined ? ` across ${s.currentKbScopes} scope(s)` : '') + '\n' +
          `  orphaned partitions: ${s.otherKbPartitions.length ? s.otherKbPartitions.map((p) => `${p.kbId}=${p.entryCount}`).join(', ') : '(none)'}\n` +
          `  legacy-root entries: ${s.legacyRootDatedEntries}`
        );
      }
      console.log('\n--- Serialized size per key (sync-limit suspects) ---');
      for (const s of keySizes) {
        console.log(`  ${s.label}: ${s.chars.toLocaleString()} chars (~${s.approxKB} KB)  [${s.key}]`);
      }
      console.log('\n--- Live write-side inputs (what QueueExit uses) ---');
      console.log(live);
      console.log('\n--- RAW JSON (all keys) ---');
      console.log(JSON.stringify(rawByKey, null, 2));
      console.log('==========================================\n');

      // ---- Export ----
      const exportObj = {
        exportedAt: new Date().toISOString(),
        currentKbId,
        isPrimary,
        analysis: stores,
        keySizes,
        live,
        raw: rawByKey,
      };
      const json = JSON.stringify(exportObj, null, 2);

      // Compact card-only export — enough to restore the lost card history, and small
      // enough to copy manually on mobile where file download / clipboard API fail.
      const cardOnlyJson = JSON.stringify({
        exportedAt: exportObj.exportedAt,
        currentKbId,
        isPrimary,
        raw: {
          [cardPriorityShieldHistoryKey]: rawByKey[cardPriorityShieldHistoryKey] ?? null,
          [documentCardPriorityShieldHistoryKey]: rawByKey[documentCardPriorityShieldHistoryKey] ?? null,
        },
      });
      setShieldExport({ full: json, cardOnly: cardOnlyJson });

      let copied = false;
      try {
        await navigator.clipboard.writeText(json);
        copied = true;
      } catch { /* clipboard may be blocked in the iframe */ }

      let downloaded = false;
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `shield-history-dump-${dayjs().format('YYYY-MM-DD-HHmmss')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        downloaded = true;
      } catch (e) {
        console.warn('[ShieldDump] File download failed (iframe sandbox?):', e);
      }

      setShieldDump({ currentKbId, isPrimary, stores, keySizes, live });

      const cardKb = stores.find((s) => s.key === cardPriorityShieldHistoryKey);
      await plugin.app.toast(
        `Shield dump done — Card KB: ${cardKb?.status ?? '?'}. ` +
        `${downloaded ? 'JSON downloaded. ' : ''}${copied ? 'Copied to clipboard. ' : ''}See console + UI.`
      );
    } catch (e) {
      console.error('[ShieldDump] Error:', e);
      await plugin.app.toast('Shield dump failed — check console.');
    } finally {
      setIsDumpingShield(false);
    }
  };

  // Inspects the rem named in a "Diff for <remId> is too large to sync" error.
  // Tells us what that rem is (a plugin-storage backing rem, a normal doc, …),
  // how big its text is, and — if it holds JSON — what top-level keys it carries,
  // so we can tell whether the stranded card-shield history lives inside it.
  const handleProbeSyncRem = async () => {
    const targetId = syncRemIdInput.trim();
    if (!targetId) {
      await plugin.app.toast('Enter a rem id first.');
      return;
    }
    setIsProbingSyncRem(true);
    try {
      const r = await plugin.rem.findOne(targetId);
      if (!r) {
        setSyncRemProbe({
          remId: targetId, found: false, remType: null, textPreview: null, textChars: 0,
          looksLikeJson: false, jsonTopKeysPreview: null, powerups: [], parentId: null,
          parentText: null, ancestorTexts: [], childCount: 0,
        });
        console.log(`\n========== SYNC REM PROBE: ${targetId} ==========\nfindOne() returned null — not a rem this plugin can read (likely an internal/other-plugin storage doc).\n`);
        await plugin.app.toast('Rem not found via plugin API — see console.');
        return;
      }

      const textStr = r.text ? await plugin.richText.toString(r.text) : '';
      let looksLikeJson = false;
      let jsonTopKeysPreview: string[] | null = null;
      const trimmed = textStr.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          looksLikeJson = true;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            jsonTopKeysPreview = Object.keys(parsed).slice(0, 40);
          }
        } catch { /* not valid JSON */ }
      }

      const POWERUP_CHECK: [string, string][] = [
        ['Incremental', powerupCode], ['cardPriority', 'cardPriority'],
        ['Document', BuiltInPowerupCodes.Document], ['Deck', BuiltInPowerupCodes.Deck],
        ['DailyDocument', BuiltInPowerupCodes.DailyDocument], ['UploadedFile', BuiltInPowerupCodes.UploadedFile],
      ];
      const powerups: string[] = [];
      for (const [label, code] of POWERUP_CHECK) {
        try { if (await r.hasPowerup(code)) powerups.push(label); } catch { /* ignore */ }
      }

      const parent = await r.getParentRem();
      const parentText = parent ? (parent.text ? await plugin.richText.toString(parent.text) : '') : null;

      const ancestorTexts: string[] = [];
      let cursor = parent;
      let guard = 0;
      while (cursor && guard < 8) {
        ancestorTexts.push(cursor.text ? await plugin.richText.toString(cursor.text) : '(untitled)');
        cursor = await cursor.getParentRem();
        guard++;
      }

      const children = await r.getChildrenRem();

      const probe = {
        remId: targetId,
        found: true,
        remType: powerups.length ? powerups.join(', ') : '(no recognized powerups)',
        textPreview: textStr.slice(0, 500),
        textChars: textStr.length,
        looksLikeJson,
        jsonTopKeysPreview,
        powerups,
        parentId: parent?._id ?? null,
        parentText,
        ancestorTexts,
        childCount: children.length,
      };

      console.log(`\n========== SYNC REM PROBE: ${targetId} ==========`);
      console.log('Found:', true);
      console.log('Text chars:', textStr.length, `(~${Math.round((textStr.length / 1024) * 10) / 10} KB)`);
      console.log('Looks like JSON:', looksLikeJson);
      if (jsonTopKeysPreview) console.log('JSON top-level keys:', jsonTopKeysPreview);
      console.log('Powerups:', powerups);
      console.log('Parent:', parent?._id, '→', parentText);
      console.log('Ancestor chain:', ancestorTexts);
      console.log('Child count:', children.length);
      console.log('Text preview:', textStr.slice(0, 1000));
      console.log('==========================================\n');

      setSyncRemProbe(probe);
      await plugin.app.toast(`Sync rem probed — ${textStr.length.toLocaleString()} chars. See console + UI.`);
    } catch (e) {
      console.error('[SyncRemProbe] Error:', e);
      await plugin.app.toast('Sync rem probe failed — check console.');
    } finally {
      setIsProbingSyncRem(false);
    }
  };

  // The shield stores that a restore may merge into. Card keys are the usual
  // recovery target; IncRem keys are included so a full export can be restored too.
  const RESTORABLE_SHIELD_KEYS = [
    cardPriorityShieldHistoryKey,
    documentCardPriorityShieldHistoryKey,
    priorityShieldHistoryKey,
    documentPriorityShieldHistoryKey,
  ];

  // Loads the cleanup-backup index and summarises each backup for the picker.
  const handleLoadBackups = async () => {
    try {
      const index = (await plugin.storage.getSynced<string[]>(cardShieldCleanupBackupIndexKey)) || [];
      const rows: NonNullable<typeof backupList> = [];
      for (const key of index) {
        const backup = await plugin.storage.getSynced<any>(key);
        const removed = backup?.removed ?? {};
        const dateEntries = Object.values(removed).reduce((sum: number, v) => sum + countDatesDeep(v), 0);
        rows.push({ key, backedUpAt: backup?.backedUpAt ?? null, kbId: backup?.kbId ?? null, dateEntries });
      }
      rows.sort((a, b) => (b.backedUpAt ?? 0) - (a.backedUpAt ?? 0));
      setBackupList(rows);
      await plugin.app.toast(`Found ${rows.length} shield backup(s).`);
    } catch (e) {
      console.error('[ShieldRestore] Load backups failed:', e);
      await plugin.app.toast('Could not load backups — check console.');
    }
  };

  // Merges a { storageKey -> value } source map into the live shield stores,
  // additively (never overwrites an existing dated entry). Confirms first.
  const applyRestore = async (sourceMap: Record<string, any>, sourceLabel: string) => {
    const present = RESTORABLE_SHIELD_KEYS.filter(
      (k) => sourceMap[k] && typeof sourceMap[k] === 'object'
    );
    if (present.length === 0) {
      await plugin.app.toast('No shield-history keys found in that source.');
      return;
    }

    const preview = present
      .map((k) => `• ${k}: +${countDatesDeep(sourceMap[k])} entr(ies) to merge`)
      .join('\n');
    const confirmed = confirm(
      `Restore shield history from ${sourceLabel}?\n\n${preview}\n\n` +
      `This MERGES into your live history and never overwrites an existing day, so current data is safe. Continue?`
    );
    if (!confirmed) return;

    setIsRestoring(true);
    try {
      const perKey: NonNullable<typeof restoreResult>['perKey'] = [];
      for (const storageKey of present) {
        const live = (await plugin.storage.getSynced<Record<string, any>>(storageKey)) || {};
        const { added, skipped } = mergeShieldAdditive(live, sourceMap[storageKey]);
        if (added > 0) {
          await plugin.storage.setSynced(storageKey, live);
        }
        perKey.push({ key: storageKey, added, skipped });
        console.log(`[ShieldRestore] ${storageKey}: +${added} added, ${skipped} already present.`);
      }
      setRestoreResult({ perKey, source: sourceLabel });
      const totalAdded = perKey.reduce((s, p) => s + p.added, 0);
      await plugin.app.toast(`Restore done — ${totalAdded} entr(ies) merged. Reopen the graph to see them.`);
    } catch (e) {
      console.error('[ShieldRestore] Restore failed:', e);
      await plugin.app.toast('Restore failed — check console.');
    } finally {
      setIsRestoring(false);
    }
  };

  // Extracts a { storageKey -> value } map from a cleanup backup ({removed}),
  // a shield-dump export ({raw}), or a bare {storageKey: value} object.
  const extractSourceMap = (parsed: any): Record<string, any> | null => {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.removed && typeof parsed.removed === 'object') return parsed.removed;
    if (parsed.raw && typeof parsed.raw === 'object') return parsed.raw;
    return parsed;
  };

  const handleRestoreFromBackupKey = async (backupKey: string) => {
    const backup = await plugin.storage.getSynced<any>(backupKey);
    const sourceMap = extractSourceMap(backup);
    if (!sourceMap) {
      await plugin.app.toast('That backup is empty or unreadable.');
      return;
    }
    await applyRestore(sourceMap, `backup "${backupKey}"`);
  };

  const handleRestoreFromJson = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(restoreJsonInput);
    } catch (e) {
      await plugin.app.toast(`Invalid JSON: ${String(e)}`);
      return;
    }
    const sourceMap = extractSourceMap(parsed);
    if (!sourceMap) {
      await plugin.app.toast('JSON did not contain shield data (expected `raw`, `removed`, or storage keys).');
      return;
    }
    await applyRestore(sourceMap, 'pasted JSON');
  };

  // Saves the current card shield history to a NEW synced backup key (+ index) so
  // it can be recovered without file/clipboard. Because it's a fresh key the server
  // has never seen, it pushes up cleanly when an offline device reconnects — even if
  // the incoming empty state wipes the live card keys — and then appears under
  // Restore → "Load backups" on any synced device.
  const handleSnapshotToSyncedBackup = async () => {
    try {
      const kbData = await plugin.kb.getCurrentKnowledgeBaseData();
      const kbId = kbData?._id || 'global';
      const isPrimary = await plugin.kb.isPrimaryKnowledgeBase();
      const cardKb = await plugin.storage.getSynced<any>(cardPriorityShieldHistoryKey);
      const cardDoc = await plugin.storage.getSynced<any>(documentCardPriorityShieldHistoryKey);
      const entries = countDatesDeep(cardKb) + countDatesDeep(cardDoc);
      if (entries === 0) {
        await plugin.app.toast('No card history present on this device to snapshot.');
        return;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const key = `${cardShieldCleanupBackupPrefix}${kbId}-manual-${ts}`;
      await plugin.storage.setSynced(key, {
        backedUpAt: Date.now(),
        kbId,
        isPrimary,
        removed: {
          [cardPriorityShieldHistoryKey]: cardKb ?? {},
          [documentCardPriorityShieldHistoryKey]: cardDoc ?? {},
        },
      });
      const index = (await plugin.storage.getSynced<string[]>(cardShieldCleanupBackupIndexKey)) || [];
      if (!index.includes(key)) {
        index.push(key);
        await plugin.storage.setSynced(cardShieldCleanupBackupIndexKey, index);
      }
      console.log(`[Snapshot] Saved ${entries} card entries to synced backup "${key}".`);
      await plugin.app.toast(`Snapshot saved (${entries} entries). Reconnect this device to sync it, then on another device use Restore → "Load backups".`);
    } catch (e) {
      console.error('[Snapshot] Failed:', e);
      await plugin.app.toast('Snapshot failed — check console.');
    }
  };

  // Reliable copy for mobile: navigator.clipboard is frequently blocked inside the
  // plugin iframe on Android, so try the legacy execCommand path (temporary
  // textarea) first, then fall back to the async API.
  const copyTextFallback = async (text: string) => {
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(ta);
    } catch { ok = false; }
    if (!ok) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* ignore */ }
    }
    await plugin.app.toast(ok ? 'Copied to clipboard.' : 'Copy failed — long-press the box and Select All → Copy.');
  };

  const handleSearchProbe = async () => {
    if (!remId) return;
    setIsProbingSearch(true);
    try {
      const r = await plugin.rem.findOne(remId);
      if (!r) { await plugin.app.toast('No rem found!'); return; }

      const rawText = (r.text ?? []) as any[];
      const plainString = await plugin.richText.toString(rawText);

      // --- Classify each rich-text element of the rem's OWN text ---
      let literalCharCount = 0;
      const elements = rawText.map((el: any, idx: number) => {
        if (typeof el === 'string') {
          literalCharCount += el.length;
          return { idx, kind: 'plain-string', detail: JSON.stringify(el) };
        }
        const i = el?.i;
        switch (i) {
          case 'm': {
            literalCharCount += (el.text ?? '').length;
            const fmt = Object.keys(el).filter((k) => k !== 'i' && k !== 'text');
            return { idx, kind: 'text (i:m)', detail: `"${el.text}"${fmt.length ? ` [fmt: ${fmt.join(', ')}]` : ''}` };
          }
          case 'q':
            return { idx, kind: 'rem-reference (i:q)', detail: `ref→${el._id}${el.aliasId ? ` alias→${el.aliasId}` : ''}${el.content ? ' (content/portal)' : ''}` };
          case 'x':
            return { idx, kind: 'latex (i:x)', detail: `"${el.text}"` };
          case 'i':
            return { idx, kind: 'image (i:i)', detail: el.url ?? '' };
          case 'a':
            return { idx, kind: 'audio (i:a)', detail: el.url ?? '' };
          case 'g':
            return { idx, kind: 'global-name (i:g)', detail: String(el._id) };
          default:
            return { idx, kind: `other (i:${i ?? '?'})`, detail: JSON.stringify(el).slice(0, 120) };
        }
      });

      // --- Unicode / normalization analysis (NFC vs NFD mismatch hides
      //     accented rems from search even when they look identical) ---
      const nfc = plainString.normalize('NFC');
      const nfd = plainString.normalize('NFD');
      const isNFC = plainString === nfc;
      const nfcDiffers = plainString !== nfc;
      const nfdDiffers = plainString !== nfd;
      const hasLeadingTrailingWhitespace = plainString !== plainString.trim();

      const chars = Array.from(plainString);
      const codePoints = chars.map((ch) => ({ char: ch, codePoint: codePointOf(ch) }));
      const suspiciousChars: Array<{ index: number; char: string; codePoint: string; name: string }> = [];
      chars.forEach((ch, index) => {
        const cp = ch.codePointAt(0) ?? 0;
        if (SUSPICIOUS_CHARS[ch] || (cp < 0x20) || cp === 0x7f) {
          suspiciousChars.push({ index, char: ch, codePoint: codePointOf(ch), name: SUSPICIOUS_CHARS[ch] ?? 'CONTROL CHARACTER' });
        }
      });

      // --- Type + special flags that affect search eligibility ---
      const type = await r.getType();
      const typeLabel = `${RemType[type] ?? 'UNKNOWN'} (${type})`;
      const flags: Record<string, boolean> = {};
      const safe = async (label: string, fn: () => Promise<boolean>) => {
        try { flags[label] = await fn(); } catch { flags[label] = false; }
      };
      await safe('isDocument', () => r.isDocument());
      await safe('isProperty', () => r.isProperty());
      await safe('isPowerupProperty', () => r.isPowerupProperty());
      await safe('isPowerup', () => r.isPowerup());
      await safe('isPowerupEnum', () => r.isPowerupEnum());
      await safe('isSlot', () => (r as any).isSlot());
      await safe('isCardItem', () => r.isCardItem());
      await safe('isTodo', () => r.isTodo());
      await safe('hasBackText', async () => Array.isArray(r.backText) && r.backText.length > 0);
      await safe('usedAsTag', () => r.hasPowerup(BuiltInPowerupCodes.UsedAsTag));
      await safe('superPrivate', () => r.hasPowerup(BuiltInPowerupCodes.SuperPrivate));
      await safe('restoredFromTrash', () => r.hasPowerup(BuiltInPowerupCodes.RestoredFromTrash));

      // --- Walk the ancestor chain for CONTEXT-level exclusion signals ---
      // A brand-new rem with this same text is found in a DIFFERENT document but
      // not here, so the cause is in the lineage. SuperPrivate / SearchPortal /
      // ImportedDocument / Collection on any ancestor (or a hidden/portal state)
      // can hide a whole subtree from normal search.
      const ANCESTOR_POWERUPS: Array<[string, string]> = [
        ['SuperPrivate', BuiltInPowerupCodes.SuperPrivate],
        ['SearchPortal', BuiltInPowerupCodes.SearchPortal],
        ['ImportedDocument', BuiltInPowerupCodes.ImportedDocument],
        ['Collection', BuiltInPowerupCodes.Collection],
        ['RestoredFromTrash', BuiltInPowerupCodes.RestoredFromTrash],
        ['Document', BuiltInPowerupCodes.Document],
        ['Deck', BuiltInPowerupCodes.Deck],
        ['UsedAsTag', BuiltInPowerupCodes.UsedAsTag],
        ['HideQueueAncestors', BuiltInPowerupCodes.HideQueueAncestors],
      ];
      const ancestors: Array<{ id: string; text: string; type: string; powerups: string[]; portalType: string | null; hidden: string | null; isDocument: boolean }> = [];
      let suspiciousAncestorPowerups: string[] = [];
      try {
        let cur = await r.getParentRem();
        let depth = 0;
        while (cur && depth < 50) {
          const ap: string[] = [];
          for (const [label, code] of ANCESTOR_POWERUPS) {
            try { if (await cur.hasPowerup(code)) ap.push(label); } catch { /* ignore */ }
          }
          let portalType: string | null = null;
          try { const pt = await cur.getPortalType(); portalType = pt != null ? String(pt) : null; } catch { /* ignore */ }
          let hidden: string | null = null;
          try { const h = await cur.getHiddenExplicitlyIncludedState(); hidden = h ?? null; } catch { /* ignore */ }
          ancestors.push({
            id: cur._id,
            text: (await plugin.richText.toString(cur.text ?? [])).slice(0, 60),
            type: `${RemType[await cur.getType().catch(() => 0)] ?? '?'}`,
            powerups: ap,
            portalType,
            hidden,
            isDocument: await cur.isDocument().catch(() => false),
          });
          for (const p of ap) {
            if (['SuperPrivate', 'SearchPortal', 'ImportedDocument', 'RestoredFromTrash'].includes(p) && !suspiciousAncestorPowerups.includes(p)) {
              suspiciousAncestorPowerups.push(p);
            }
          }
          cur = await cur.getParentRem();
          depth++;
        }
      } catch { /* ignore */ }

      let ownHiddenState: string | null = null;
      try { const h = await r.getHiddenExplicitlyIncludedState(); ownHiddenState = h ?? null; } catch { /* ignore */ }
      let inPortalsCount = 0;
      try { inPortalsCount = (await r.portalsAndDocumentsIn()).length; } catch { /* ignore */ }

      // --- Aliases + reference counts + search-ranking signal ---
      let aliases: Array<{ id: string; text: string }> = [];
      try {
        const aliasRems = await r.getAliases();
        aliases = await Promise.all(aliasRems.map(async (a: any) => ({ id: a._id, text: await plugin.richText.toString(a.text) })));
      } catch { /* ignore */ }

      let timesSelected: number | null = null;
      try { timesSelected = await r.timesSelectedInSearch(); } catch { timesSelected = null; }

      let referencedByCount = 0;
      try { referencedByCount = (await r.remsReferencingThis()).length; } catch { /* ignore */ }
      let referencesCount = 0;
      try { referencesCount = (await r.remsBeingReferenced()).length; } catch { /* ignore */ }

      // --- Reproduce the reference search programmatically ---
      // This is the decisive test: run the SAME search the editor uses and see
      // whether this rem appears, at what rank, and how many results outrank it.
      const normalizeForCompare = (s: string) => s.normalize('NFC').trim().toLowerCase();
      const ownNormalized = normalizeForCompare(plainString);
      const runSearch = async (
        label: string,
        query: any[],
        opts: { filterOnlyConcepts?: boolean; numResults?: number }
      ): Promise<{ count: number; rank: number; results: any[] }> => {
        try {
          const results = await plugin.search.search(query, undefined, opts);
          const ids = results.map((x: any) => x._id);
          const rank = ids.indexOf(remId);
          console.log(`[search-probe] search(${label}) → ${results.length} results; this rem rank: ${rank === -1 ? 'NOT FOUND' : `#${rank + 1}`}`);
          const preview = await Promise.all(
            results.slice(0, 15).map(async (x: any, i: number) => `   ${i + 1}. ${x._id === remId ? '👉 ' : ''}[${RemType[await x.getType().catch(() => 0)] ?? '?'}] "${(await plugin.richText.toString(x.text)).slice(0, 60)}" (${x._id})`)
          );
          console.log(preview.join('\n'));
          return { count: results.length, rank, results };
        } catch (e) {
          console.warn(`[search-probe] search(${label}) threw:`, e);
          return { count: -1, rank: -1, results: [] };
        }
      };

      console.log(`\n========== SEARCH / LINKAGE PROBE: "${plainString}" (${remId}) ==========`);
      console.log('Type:', typeLabel);
      console.log('Raw text:', JSON.stringify(rawText));
      console.log('Back text:', JSON.stringify(r.backText ?? null));
      console.log('Plain string:', JSON.stringify(plainString), `| length: ${plainString.length} | literal chars in own text: ${literalCharCount}`);
      console.log('Element breakdown:', elements);
      console.log('Unicode → isNFC:', isNFC, '| NFC differs:', nfcDiffers, '| NFD differs:', nfdDiffers, '| leading/trailing ws:', hasLeadingTrailingWhitespace);
      console.log('Code points:', codePoints);
      if (suspiciousChars.length) console.warn('SUSPICIOUS CHARACTERS:', suspiciousChars);
      console.log('Flags:', flags);
      console.log('Aliases:', aliases);
      console.log('timesSelectedInSearch:', timesSelected, '| referencedBy:', referencedByCount, '| references:', referencesCount);

      const searchAll = await runSearch('own text, all types, 50', rawText, { filterOnlyConcepts: false, numResults: 50 });
      const searchConcepts = await runSearch('own text, concepts only, 50', rawText, { filterOnlyConcepts: true, numResults: 50 });

      // Deep-retrieval test: request far more results than the editor's omnibar
      // shows. If the rem appears at a large N but not at 50, it IS in the index
      // — just out-ranked by a flood of common-token partial matches — and a
      // custom re-ranking picker can surface it. If it's absent even at N=1000,
      // candidate generation itself excludes it (token saturation).
      const searchDeep = await runSearch('own text, all types, 1000', rawText, { filterOnlyConcepts: false, numResults: 1000 });
      const searchDeepConcepts = await runSearch('own text, concepts only, 1000', rawText, { filterOnlyConcepts: true, numResults: 1000 });

      // --- Search by each ALIAS text ---
      // If the rem is findable under an alias but NOT its primary name, its
      // primary-name index entry is corrupt (the decisive distinction).
      const aliasSearches: Array<{ aliasText: string; aliasId: string; count: number; rank: number }> = [];
      for (const a of aliases) {
        if (!a.text.trim()) continue;
        const res = await runSearch(`alias "${a.text}"`, [a.text], { filterOnlyConcepts: false, numResults: 50 });
        aliasSearches.push({ aliasText: a.text, aliasId: a.id, count: res.count, rank: res.rank });
      }

      // --- Search by PREFIXES of the primary name ---
      // Narrows down whether SOME token of the name is indexed at all.
      const words = plainString.trim().split(/\s+/);
      const prefixSearches: Array<{ query: string; count: number; rank: number }> = [];
      const prefixQueries = new Set<string>();
      if (words[0]) prefixQueries.add(words[0]);
      if (words.length > 1) prefixQueries.add(words.slice(0, Math.ceil(words.length / 2)).join(' '));
      if (words.length > 1) prefixQueries.add(words[words.length - 1]);
      for (const q of prefixQueries) {
        const res = await runSearch(`prefix "${q}"`, [q], { filterOnlyConcepts: false, numResults: 50 });
        prefixSearches.push({ query: q, count: res.count, rank: res.rank });
      }

      // --- Detect duplicate rems sharing this exact (normalized) name ---
      // A duplicate concept could be occupying the canonical name slot in the
      // index and crowding this rem out.
      const dupMap = new Map<string, any>();
      for (const x of [...searchAll.results, ...searchConcepts.results]) {
        if (x._id === remId) continue;
        if (dupMap.has(x._id)) continue;
        const t = await plugin.richText.toString(x.text);
        if (normalizeForCompare(t) === ownNormalized) dupMap.set(x._id, { id: x._id, text: t });
      }
      const duplicates: Array<{ id: string; text: string; type: string }> = [];
      for (const d of dupMap.values()) {
        let tl = '?';
        try { const dr = await plugin.rem.findOne(d.id); if (dr) tl = `${RemType[await dr.getType()] ?? '?'}`; } catch { /* ignore */ }
        duplicates.push({ id: d.id, text: d.text, type: tl });
      }

      // --- Inspect the alias rems' own structure ---
      const aliasStructure: Array<{ id: string; text: string; type: string; isProperty: boolean; parentIsThis: boolean }> = [];
      for (const a of aliases) {
        try {
          const ar = await plugin.rem.findOne(a.id);
          if (!ar) continue;
          aliasStructure.push({
            id: a.id,
            text: a.text,
            type: `${RemType[await ar.getType()] ?? '?'}`,
            isProperty: await ar.isProperty().catch(() => false),
            parentIsThis: (ar.parent ?? null) === remId,
          });
        } catch { /* ignore */ }
      }
      console.log('Alias searches:', aliasSearches);
      console.log('Prefix searches:', prefixSearches);
      console.log('Duplicate same-name rems:', duplicates);
      console.log('Alias structure:', aliasStructure);
      console.log('Own hidden state:', ownHiddenState, '| in portals/docs:', inPortalsCount);
      console.log('Ancestor chain (root last):', ancestors);
      if (suspiciousAncestorPowerups.length) console.warn('SUSPICIOUS ANCESTOR POWERUPS:', suspiciousAncestorPowerups);

      // --- findByName cross-check ---
      let foundByNameGlobal: string | null = null;
      let foundByNameUnderParent: string | null = null;
      try {
        const g = await plugin.rem.findByName(rawText, null);
        foundByNameGlobal = g ? g._id : null;
      } catch { /* ignore */ }
      try {
        const parent = await r.getParentRem();
        const p = parent ? await plugin.rem.findByName(rawText, parent._id) : undefined;
        foundByNameUnderParent = p ? p._id : null;
      } catch { /* ignore */ }
      console.log('findByName(global):', foundByNameGlobal, foundByNameGlobal === remId ? '(== this rem)' : '(different / none)');
      console.log('findByName(under parent):', foundByNameUnderParent, foundByNameUnderParent === remId ? '(== this rem)' : '(different / none)');

      // --- Build verdict ---
      const issues: string[] = [];
      if (literalCharCount === 0) {
        issues.push('Rem has NO literal text characters of its own (text is composed only of references/media). Reference search has nothing to match — this is almost certainly why it is invisible.');
      }
      if (nfcDiffers) {
        issues.push('Text is NOT in NFC normalization form (decomposed accents). Typing the precomposed form in search will not match. Re-typing/retyping the title fixes this.');
      }
      if (suspiciousChars.length) {
        issues.push(`Text contains ${suspiciousChars.length} hidden/zero-width/control character(s) (${suspiciousChars.map((s) => s.codePoint).join(', ')}). These break exact matching.`);
      }
      if (hasLeadingTrailingWhitespace) {
        issues.push('Text has leading/trailing whitespace.');
      }
      if (flags.isProperty || flags.isPowerupProperty || flags.isSlot || flags.isPowerup || flags.isPowerupEnum) {
        issues.push('Rem is a property/slot/powerup rem — these are excluded from normal concept reference search.');
      }
      const foundUnderAlias = aliasSearches.some((a) => a.rank !== -1);
      const foundUnderPrefix = prefixSearches.some((p) => p.rank !== -1);
      const ownSearchFails = searchAll.rank === -1 && searchConcepts.rank === -1;
      const deepRank = searchDeep.rank !== -1 ? searchDeep.rank : searchDeepConcepts.rank;

      if (suspiciousAncestorPowerups.length > 0) {
        issues.push(`CONTEXT-LEVEL EXCLUSION: an ancestor carries ${suspiciousAncestorPowerups.join(', ')}. Rems under a SuperPrivate / SearchPortal / ImportedDocument / RestoredFromTrash ancestor are hidden from normal reference search — this matches "same text works in a different document". Fix: locate the flagged ancestor in the chain below and remove/relocate that powerup (or move the rem out of that branch).`);
      }
      if (ownHiddenState === 'hidden') {
        issues.push('This rem\'s own hidden-state is "hidden" — it is explicitly excluded from its context.');
      }

      if (ownSearchFails && searchAll.count > 0) {
        if (deepRank !== -1) {
          issues.push(`COMMON-PHRASE SATURATION: the rem is absent from the top 50 but DOES appear at rank #${deepRank + 1} when ${searchDeep.count >= 1000 || searchDeepConcepts.count >= 1000 ? '1000' : 'more'} results are requested. It is in the index — just out-ranked by a flood of rems sharing these common tokens. RemNote's omnibar caps results, so it never shows. Renaming/re-typing will NOT help; use the "Find & Insert Reference" command (opt+shift+f) — it pulls many results per-token and floats exact-name matches to the top.`);
        } else {
          issues.push('The rem does NOT appear even when requesting 1000 results for its own text — RemNote\'s candidate generation excludes it (its common tokens are saturated). A custom picker that searches by the rem\'s rarest token or by alias, then floats exact-name matches up, is the reliable workaround. (Searching by a distinctive alias already finds it, per the alias rows above.)');
        }
        if (duplicates.length > 0) {
          issues.push(`A DUPLICATE rem with the same name exists (${duplicates.map((d) => `${d.id} [${d.type}]`).join(', ')}).`);
        }
        if (foundUnderAlias || foundUnderPrefix) {
          issues.push(`Note: the rem IS reachable via alias/distinctive-prefix search (${[...aliasSearches, ...prefixSearches].filter((x: any) => x.rank !== -1).map((x: any) => `"${x.aliasText ?? x.query}" #${x.rank + 1}`).join(', ')}). So adding a distinctive alias is a usable manual workaround.`);
        }
      } else if (searchAll.rank === -1 && searchAll.count > 0) {
        issues.push(`Rem does NOT appear in the top ${searchAll.count} results of its own text search (all types) but DOES under concepts-only — partial ranking issue. Check timesSelectedInSearch (${timesSelected}).`);
      } else if (searchAll.rank > 9) {
        issues.push(`Rem appears only at rank #${searchAll.rank + 1} in its own search — below the typical visible cutoff. Selecting it once should raise its timesSelectedInSearch and surface it.`);
      }
      if (issues.length === 0) {
        issues.push('No obvious structural cause found. The rem is a normal, searchable concept. If it still cannot be found interactively, compare timesSelectedInSearch and rank against a working rem.');
      }

      console.log('VERDICT:', issues);
      console.log('===========================================\n');

      setSearchProbe({
        plainString,
        typeLabel,
        elements,
        literalCharCount,
        aliases,
        timesSelectedInSearch: timesSelected,
        referencedByCount,
        referencesCount,
        flags,
        isNFC,
        nfcDiffers,
        nfdDiffers,
        hasLeadingTrailingWhitespace,
        suspiciousChars,
        codePoints,
        aliasSearches,
        prefixSearches,
        duplicates,
        aliasStructure,
        ownSearchRank: searchAll.rank,
        ownSearchCount: searchAll.count,
        conceptSearchRank: searchConcepts.rank,
        deepSearchRank: searchDeep.rank,
        deepSearchCount: searchDeep.count,
        deepConceptRank: searchDeepConcepts.rank,
        ancestors,
        suspiciousAncestorPowerups,
        ownHiddenState,
        inPortalsCount,
        issues,
      });
      await plugin.app.toast(`Search probe complete — ${issues.length} note(s). See widget + console.`);
    } catch (e) {
      console.error('[search-probe] Error:', e);
      await plugin.app.toast('Search probe failed — check console.');
    } finally {
      setIsProbingSearch(false);
    }
  };

  const preStyle = { backgroundColor: 'var(--rn-clr-background-secondary)', padding: '8px', borderRadius: '4px', marginTop: '4px', fontSize: '11px', overflowX: 'auto' as 'auto' };
  const smallBtnStyle: CSSProperties = { fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: 'pointer' };

  // ── SECTION ORDER — please preserve ──────────────────────────────────────
  //
  // This widget is opened to answer a question about ONE Rem, so the sections
  // that describe the focused Rem come first and must stay there:
  //
  //   1. General Data              — Rem id and the top-level toggles
  //   2. Incremental Powerup       ← KEEP AT TOP
  //   3. Incremental Raw Slots
  //   4. Card Priority Powerup     ← KEEP AT TOP
  //   5. Dismissed Powerup
  //   6. …other per-Rem readouts (cards, PDF structure, page history)…
  //
  // Everything that describes the KNOWLEDGE BASE rather than the focused Rem
  // goes after those — settings migration, shield history, the CardPriority tag
  // audit — and the whole-KB forensic tools go last, in "Raw Slot Diagnostics".
  //
  // Two ways this drifted before, both worth not repeating:
  //   * "Dump Raw Slots" was bolted onto the *Card Priority* section header,
  //     where it had nothing to do with card priority.
  //   * The settings-migration and shield-history blocks sat directly under
  //     General Data, pushing the Incremental / Card Priority readouts — the
  //     reason this widget gets opened at all — below the fold.
  //
  // Rule of thumb: if a control does not describe the focused Rem, it does not
  // belong above the per-Rem sections.
  return (
    <div className="incremental-everything-debug p-4 max-h-[80vh] overflow-y-auto" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', color: 'var(--rn-clr-content-primary)', boxSizing: 'border-box' }}>
      <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
         General Data
         <button
           onClick={handleDeepLog}
           style={{
             fontSize: '11px',
             padding: '2px 8px',
             backgroundColor: 'var(--rn-clr-background-secondary)',
             color: 'var(--rn-clr-content-primary)',
             border: '1px solid var(--rn-clr-border)',
             borderRadius: '4px',
             cursor: 'pointer'
           }}
         >
           Deep Log Structure
         </button>
         <button
           onClick={handleProbeSlotApi}
           style={{
             fontSize: '11px',
             padding: '2px 8px',
             backgroundColor: 'var(--rn-clr-background-secondary)',
             color: 'var(--rn-clr-content-primary)',
             border: '1px solid var(--rn-clr-border)',
             borderRadius: '4px',
             cursor: 'pointer'
           }}
         >
           Probe Slot API
         </button>
         <button
           onClick={handleTagAudit}
           disabled={isAuditingTags}
           style={{
             fontSize: '11px',
             padding: '2px 8px',
             backgroundColor: 'var(--rn-clr-background-secondary)',
             color: 'var(--rn-clr-content-primary)',
             border: '1px solid var(--rn-clr-border)',
             borderRadius: '4px',
             cursor: isAuditingTags ? 'wait' : 'pointer'
           }}
           title="KB-wide: cross-check getPowerupByCode('cardPriority').taggedRem() against a direct hasPowerup probe over every card-bearing rem"
         >
           {isAuditingTags ? 'Auditing…' : 'CardPriority Tag Audit'}
         </button>
      </h2>
      <Info className="rem-id" label="Rem ID" data={<code>{remId}</code>} />

      <div className="flex gap-4">
        <Info className="card-disabled" label="Cards Disabled (Locally)" data={isCardDisabledLocally ? <span style={{color: '#ef4444', fontWeight: 600}}>YES</span> : 'No'} />
        <Info className="card-disabled-ancestor" label="Cards Disabled (Inherited)" data={isCardDisabledInAncestors ? <span style={{color: '#ef4444', fontWeight: 600}}>YES</span> : 'No'} />
      </div>

      {incrementalRem && (
        <div style={{ marginTop: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>Incremental Powerup</h2>
          <Info className="next-rep-date" label="Next Rep (Raw)" data={incrementalRem.nextRepDate} />
          <Info
            className="human-date"
            label="Next Rep (Human)"
            data={`${dayjs(incrementalRem.nextRepDate).format('MMMM D, YYYY')} (${dayjs(incrementalRem.nextRepDate).fromNow()})`}
          />
          {/* Priority is no longer just a number: show where it came from, so a
              recovered or placeholder value can never pass for a stored one. */}
          <Info
            className="priority"
            label="Priority"
            data={
              <span>
                {incrementalRem.priority}
                {incrementalRem.prioritySource === 'history' && (
                  <span style={{ marginLeft: '8px', fontSize: '11px', color: '#f59e0b', fontWeight: 600 }}>
                    ⚠ recovered from history — the Priority slot is unreadable
                  </span>
                )}
                {incrementalRem.prioritySource === 'fallback' && (
                  <span style={{ marginLeft: '8px', fontSize: '11px', color: '#ef4444', fontWeight: 600 }}>
                    ⚠ placeholder — neither the slot nor the history holds a priority
                  </span>
                )}
              </span>
            }
          />
          <Info
            className="created-at-raw"
            label="Created At (Raw)"
            data={incrementalRem.createdAt !== undefined
              ? incrementalRem.createdAt
              : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>Not set (dismissed or legacy rem)</span>}
          />
          <Info
            className="created-at-human"
            label="Created At (Human)"
            data={incrementalRem.createdAt !== undefined
              ? `${dayjs(incrementalRem.createdAt).format('MMMM D, YYYY')} (${dayjs(incrementalRem.createdAt).fromNow()})`
              : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>Not set (dismissed or legacy rem)</span>}
          />
          <div className="history flex flex-col mb-2">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="font-semibold text-xs text-[var(--rn-clr-content-tertiary)] uppercase tracking-wider">History</div>
              {!isEditingHistory ? (
                <button onClick={handleEditHistory} style={smallBtnStyle}>Edit</button>
              ) : (
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    onClick={handleSaveHistory}
                    disabled={isSavingHistory}
                    style={{ ...smallBtnStyle, cursor: isSavingHistory ? 'wait' : 'pointer', fontWeight: 600 }}
                  >
                    {isSavingHistory ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={handleCancelEditHistory} disabled={isSavingHistory} style={smallBtnStyle}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {historySlotError && (
              <div style={{ marginTop: '4px', padding: '8px', borderRadius: '4px', border: '1px solid #ef4444', backgroundColor: 'rgba(239, 68, 68, 0.08)' }}>
                <div style={{ color: '#ef4444', fontSize: '11px', fontWeight: 600 }}>
                  ⚠ Stored history is invalid — the queue reads it as empty.
                </div>
                <div style={{ color: 'var(--rn-clr-content-primary)', fontSize: '11px', marginTop: '2px', whiteSpace: 'pre-wrap' }}>
                  {historySlotError}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                  <button
                    onClick={handleRestoreHistory}
                    disabled={!historyBackupExists || isSavingHistory}
                    style={{ ...smallBtnStyle, cursor: (!historyBackupExists || isSavingHistory) ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: historyBackupExists ? 1 : 0.5 }}
                  >
                    Restore original
                  </button>
                  <span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px' }}>
                    {historyBackupExists
                      ? 'Rolls back to the snapshot taken before your last edit.'
                      : 'No restore point available (no prior edit was captured for this rem).'}
                  </span>
                </div>
              </div>
            )}
            {!isEditingHistory ? (
              <pre style={preStyle}>{incrementalRem?.history ? JSON.stringify(incrementalRem.history, null, 2) : '[]'}</pre>
            ) : (
              <>
                <textarea
                  value={historyDraft}
                  onChange={(e) => setHistoryDraft(e.target.value)}
                  spellCheck={false}
                  style={{
                    marginTop: '4px',
                    width: '100%',
                    minHeight: '240px',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    lineHeight: '1.4',
                    padding: '8px',
                    borderRadius: '4px',
                    border: `1px solid ${historyError ? '#ef4444' : 'var(--rn-clr-border)'}`,
                    backgroundColor: 'var(--rn-clr-background-secondary)',
                    color: 'var(--rn-clr-content-primary)',
                    boxSizing: 'border-box',
                    resize: 'vertical',
                  }}
                />
                {historyError && (
                  <div style={{ color: '#ef4444', fontSize: '11px', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
                    {historyError}
                  </div>
                )}
                <div style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', marginTop: '4px' }}>
                  Writes directly to the Incremental <code>repHist</code> slot. Must be a JSON array. Does not change the Next Rep date.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {rawSlotProbe && (
        <div style={{ marginTop: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
            Incremental Raw Slots (diagnostic)
          </h2>
          {/* An empty raw slot while "Priority" above shows a number means the
              number is getIncrementalRemFromRem's fallback, not stored data. */}
          <Info
            className="probe-priority"
            label="Priority slot (raw)"
            data={
              <>
                <pre style={preStyle}>{JSON.stringify(rawSlotProbe.priority, null, 2)}</pre>
                {'error' in rawSlotProbe.priority ||
                rawSlotProbe.priority.getPowerupProperty != null ||
                rawSlotProbe.priority.richTextAsString != null ? null : (
                  <div style={{ marginTop: '4px', padding: '6px', borderRadius: '4px', border: '1px solid #ef4444', backgroundColor: 'rgba(239, 68, 68, 0.08)', fontSize: '11px', color: 'var(--rn-clr-content-primary)' }}>
                    ⚠ The Priority slot reads as empty, so the{' '}
                    <strong>Priority {String(incrementalRem?.priority)}</strong> shown above is the
                    plugin's read fallback, not a stored value. Use “Dump Raw Slots” to check
                    whether the real value is still on the Rem under a detached slot.
                  </div>
                )}
              </>
            }
          />
          <Info
            className="probe-next-rep"
            label="Next Rep reference"
            data={<pre style={preStyle}>{JSON.stringify(rawSlotProbe.nextRepDate, null, 2)}</pre>}
          />
          <Info
            className="probe-created"
            label="Created reference"
            data={<pre style={preStyle}>{JSON.stringify(rawSlotProbe.originalIncDate, null, 2)}</pre>}
          />
        </div>
      )}


      {cardPriority && (
        <div style={{ marginTop: '16px' }}>
           <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             Card Priority Powerup
             <div style={{ display: 'flex', gap: '6px' }}>
               <button
                 onClick={handleCleanDescendants}
                 style={{
                   fontSize: '11px',
                   padding: '2px 8px',
                   backgroundColor: 'var(--rn-clr-background-warning)',
                   color: 'var(--rn-clr-content-warning)',
                   border: '1px solid var(--rn-clr-border-warning)',
                   borderRadius: '4px',
                   cursor: 'pointer'
                 }}
                 title="Scan all descendants of this Rem and remove cardPriority from non-flashcard Rems"
               >
                 Clean Descendants (No Cards)
               </button>
               <button
                 onClick={handleSanitize}
                 style={{
                   fontSize: '11px',
                   padding: '2px 8px',
                   backgroundColor: 'var(--rn-clr-background-warning)',
                   color: 'var(--rn-clr-content-warning)',
                   border: '1px solid var(--rn-clr-border-warning)',
                   borderRadius: '4px',
                   cursor: 'pointer'
                 }}
               >
                 Sanitize Rogue Tags
               </button>
               <button
                 onClick={handleScrubPowerup}
                 style={{
                   fontSize: '11px',
                   padding: '2px 8px',
                   backgroundColor: 'var(--rn-clr-background-warning)',
                   color: 'var(--rn-clr-content-warning)',
                   border: '1px solid var(--rn-clr-border-warning)',
                   borderRadius: '4px',
                   cursor: 'pointer'
                 }}
                 title="Delete all CardPriority slots and let the plugin recreate them to fix duplicates"
               >
                 Scrub Duplicate Slots
               </button>
               <button
                 onClick={handleDumpStructure}
                 style={{
                   fontSize: '11px',
                   padding: '2px 8px',
                   backgroundColor: 'var(--rn-clr-background-secondary)',
                   color: 'var(--rn-clr-content-primary)',
                   border: '1px solid var(--rn-clr-border)',
                   borderRadius: '4px',
                   cursor: 'pointer'
                 }}
                 title="Walk this rem + descendants and log the full structure of every node carrying cardPriority/cards (console.table) to diagnose rogue tags"
               >
                 Dump Slot Structure
               </button>
               <button
                 onClick={handleScanImportedPriorities}
                 style={{
                   fontSize: '11px',
                   padding: '2px 8px',
                   backgroundColor: 'var(--rn-clr-background-secondary)',
                   color: 'var(--rn-clr-content-primary)',
                   border: '1px solid var(--rn-clr-border)',
                   borderRadius: '4px',
                   cursor: 'pointer'
                 }}
                 title="For rems imported from another KB: check whether their original card priorities are still present on the imported KB's CardPriority powerup (read-only)"
               >
                 Scan Imported Priorities
               </button>
               <button
                 onClick={handleDiagnoseReadPath}
                 style={{
                   fontSize: '11px',
                   padding: '2px 8px',
                   backgroundColor: 'var(--rn-clr-background-secondary)',
                   color: 'var(--rn-clr-content-primary)',
                   border: '1px solid var(--rn-clr-border)',
                   borderRadius: '4px',
                   cursor: 'pointer'
                 }}
                 title="Why can't the plugin read this rem's Incremental/CardPriority values? Compares getPowerupByCode() against the rem's actual tags and probes every slot (read-only)"
               >
                 Diagnose Read Path
               </button>
             </div>
           </h2>
           {hasSpuriousTags && (
             <div style={{ marginBottom: '12px', padding: '8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', borderRadius: '4px', fontSize: '12px', border: '1px solid var(--rn-clr-border-warning)' }}>
               ⚠️ <strong>Spurious Tags Detected:</strong> Rogue CardPriority tags were found on non-flashcard children. Please click "Sanitize Rogue Tags" to cure this rem.
             </div>
           )}
           {/* Whether anything is stored on THIS rem. Without it the block below
               reads as slot content, when for an untagged rem it is a value
               resolved from the nearest ancestor at read time. */}
           <div
             style={{
               marginBottom: '10px',
               padding: '6px 8px',
               borderRadius: '4px',
               fontSize: '11px',
               lineHeight: 1.5,
               border: '1px solid var(--rn-clr-border)',
               backgroundColor: 'var(--rn-clr-background-secondary)',
             }}
           >
               {(() => {
               const storedPriority = cardPrioritySlots.priority;
               const stored = !!storedPriority;
               return (
                 <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                   <span>
                     {stored ? (
                       <>
                         <strong style={{ color: '#16a34a' }}>Stored on this rem.</strong> The values
                         below come from this rem's own CardPriority slots.
                       </>
                     ) : hasCardPriorityTag ? (
                       <>
                         <strong style={{ color: '#d97706' }}>Tagged, but the priority slot is
                         empty.</strong> The powerup is applied to this rem, yet no value is stored
                         in its priority slot — so the numbers below are resolved on read from the
                         nearest ancestor, exactly as they would be for an untagged rem.{' '}
                         {cardPriority.cardCount > 0
                           ? '"Sanitize Rogue Tags" will NOT touch this: it only strips tags from rems that own no cards, and this one does. setCardPriority always writes priority, source and lastUpdated together, so a surviving source/lastUpdated with no priority means the value was lost after it was written, not that the write was partial. To drop tags wholesale while flashcard prioritisation is off, use the "Remove All CardPriority Tags" command.'
                           : 'This rem owns no cards, so "Sanitize Rogue Tags" is the tool that removes it.'}
                       </>
                     ) : (
                       <>
                         <strong style={{ color: '#d97706' }}>Not tagged.</strong> No CardPriority
                         powerup on this rem — the values below are resolved on read from the nearest
                         ancestor (or the default).
                       </>
                     )}
                   </span>
                   <span style={{ fontFamily: 'monospace', color: 'var(--rn-clr-content-tertiary)' }}>
                     hasPowerup={String(hasCardPriorityTag)} · slots: priority=
                     {JSON.stringify(cardPrioritySlots.priority ?? null)} source=
                     {JSON.stringify(cardPrioritySlots.source ?? null)} lastUpdated=
                     {JSON.stringify(cardPrioritySlots.lastUpdated ?? null)}
                   </span>
                 </div>
               );
             })()}
           </div>
           <div className="flex gap-4 mb-2">
             <Info className="cp-priority" label="Priority" data={cardPriority.priority} />
             <Info className="cp-source" label="Source" data={<span style={{ textTransform: 'capitalize' }}>{cardPriority.source}</span>} />
           </div>
           <div className="flex gap-4 mb-2">
             <Info className="cp-duecards" label="Due Cards" data={cardPriority.dueCards} />
             <Info className="cp-cardcount" label="Total Cards" data={cardPriority.cardCount} />
           </div>
           <Info
             className="cp-updated"
             label="Last Updated"
             data={
               cardPrioritySlots.lastUpdated
                 ? `${dayjs(cardPriority.lastUpdated).format('MMMM D, YYYY, h:mm a')} (${dayjs(cardPriority.lastUpdated).fromNow()})`
                 : '— (not stored)'
             }
           />
        </div>
      )}

      {dismissed && (
        <div style={{ marginTop: '16px' }}>
           <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             Dismissed Powerup
             <button
               onClick={handleCleanDismissed}
               style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: 'pointer' }}
             >
               Clean Dismissed Powerup
             </button>
           </h2>
           <Info className="dismissed-date" label="Dismissed Date" data={dismissed.dismissedDate ? `${dayjs(dismissed.dismissedDate).format('MMMM D, YYYY')} (${dayjs(dismissed.dismissedDate).fromNow()})` : 'None'} />
           <Info
            className="history"
            label="Dismissed History"
            data={<pre style={preStyle}>{dismissed?.history ? JSON.stringify(dismissed.history, null, 2) : '[]'}</pre>}
          />
        </div>
      )}

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Card API Comparison
          <button
            onClick={handleCardCompare}
            disabled={isComparing}
            style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isComparing ? 'wait' : 'pointer' }}
          >
            {isComparing ? 'Running…' : 'Run Comparison'}
          </button>
        </h2>
        {!cardCompare && <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>Click "Run Comparison" to compare rem.getCards() vs card.getAll() for this rem.</div>}
        {cardCompare && (
          <div>
            <div className="flex gap-4 mb-2">
              <Info className="" label="rem.getCards()" data={<strong>{cardCompare.remCards.length}</strong>} />
              <Info className="" label="card.getAll() filtered" data={<strong>{cardCompare.filteredCards.length}</strong>} />
              <Info className="" label="Total KB Cards" data={cardCompare.totalKb} />
            </div>
            <Info className="" label="Match?" data={
              cardCompare.match
                ? <span style={{ color: '#22c55e', fontWeight: 600 }}>YES — counts and IDs agree</span>
                : <span style={{ color: '#ef4444', fontWeight: 600 }}>NO — mismatch detected!</span>
            } />
            <Info className="" label="Document ancestor Status" data={
              cardCompare.documentRemId
                ? <span><code>{cardCompare.documentStatus ?? '(null/empty)'}</code><span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', marginLeft: '6px' }}>{cardCompare.documentRemId}</span></span>
                : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>No Document ancestor found</span>
            } />
            <Info className="" label="Deck ancestor Status" data={
              cardCompare.deckRemId
                ? <span><code>{cardCompare.deckStatus ?? '(null/empty)'}</code><span style={{ color: 'var(--rn-clr-content-tertiary)', fontSize: '10px', marginLeft: '6px' }}>{cardCompare.deckRemId}</span></span>
                : <span style={{ color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>No Deck ancestor found</span>
            } />
            {!cardCompare.match && cardCompare.onlyInRem.length > 0 && (
              <Info className="" label="Only in rem.getCards()" data={<pre style={preStyle}>{JSON.stringify(cardCompare.onlyInRem, null, 2)}</pre>} />
            )}
            {!cardCompare.match && cardCompare.onlyInAll.length > 0 && (
              <Info className="" label="Only in card.getAll() — missing from rem.getCards()" data={
                <pre style={preStyle}>{JSON.stringify(
                  cardCompare.filteredCards.filter(c => cardCompare.onlyInAll.includes(c.id)).map(c => {
                    let diagnosis: string;
                    if (c.disabled) {
                      diagnosis = 'DISABLED (nextRepTime=null)';
                    } else if (cardCompare.deckStatus === 'Paused') {
                      diagnosis = 'PAUSED (Deck Status="Paused")';
                    } else {
                      diagnosis = `UNKNOWN — nextRepTime set, not in rem.getCards; Deck Status="${cardCompare.deckStatus ?? 'not set'}"`;
                    }
                    return { ...c, diagnosis };
                  }),
                  null, 2
                )}</pre>
              } />
            )}
            <Info className="" label="rem.getCards() — cards" data={
              <pre style={preStyle}>{JSON.stringify(cardCompare.remCards, null, 2)}</pre>
            } />
            <Info className="" label="card.getAll() filtered — cards" data={
              <pre style={preStyle}>{JSON.stringify(cardCompare.filteredCards, null, 2)}</pre>
            } />
          </div>
        )}
      </div>
      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          PDF Structure Debug
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleDebugPDF}
              disabled={isPdfDebugging || isRepairing}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: (isPdfDebugging || isRepairing) ? 'wait' : 'pointer' }}
            >
              {isPdfDebugging ? 'Scanning…' : 'Debug PDF'}
            </button>
            <button
              onClick={handleRepairPDF}
              disabled={isPdfDebugging || isRepairing}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', border: '1px solid var(--rn-clr-border-warning)', borderRadius: '4px', cursor: (isPdfDebugging || isRepairing) ? 'wait' : 'pointer' }}
            >
              {isRepairing ? 'Repairing…' : 'Repair PDF'}
            </button>
          </div>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)' }}>
          Opens the focused rem's full descendant tree in the console — remIDs, powerups, tags, and highlight data. Run on a working PDF and a broken one to compare structures.
        </div>
      </div>

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Page History Dump (addPageToHistory raw data)
          <button
            onClick={handleDumpPageHistory}
            disabled={isDumpingHistory}
            style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isDumpingHistory ? 'wait' : 'pointer' }}
          >
            {isDumpingHistory ? 'Dumping…' : 'Dump Page History'}
          </button>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '8px' }}>
          For every PDF source on this rem, fetches the raw page-history array stored by <code>addPageToHistory</code>
          (storage key <code>pdfHistory_&lt;remId&gt;_&lt;pdfRemId&gt;</code>), shows per-entry summary, and dumps the
          full JSON to console.
        </div>
        {pageHistoryDump && pageHistoryDump.perPdf.map((p) => (
          <div key={p.pdfRemId} style={{ marginTop: '12px', padding: '8px', border: '1px solid var(--rn-clr-background-tertiary)', borderRadius: '4px' }}>
            <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: '6px' }}>
              📄 {p.pdfName} <span style={{ color: 'var(--rn-clr-content-tertiary)', fontWeight: 400 }}>({p.pdfRemId})</span>
            </div>
            <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: '6px' }}>
              <div>Total entries: <strong>{p.entryCount}</strong></div>
              <div>With duration &gt; 0: <strong>{p.durationsCount}</strong></div>
              <div>Sum of durations: <strong>{formatDuration(p.durationsSum)}</strong> ({p.durationsSum}s)</div>
              <div>getReadingStatistics total: <strong>{formatDuration(p.total)}</strong> ({p.total}s)</div>
              <div>Min duration: <strong>{p.durationsMin ?? '—'}s</strong></div>
              <div>Max duration: <strong>{p.durationsMax ?? '—'}s</strong></div>
              <div>Entries ≥ 14400s (4h cap): <strong style={{ color: p.capped14400Count > 0 ? '#ef4444' : 'inherit' }}>{p.capped14400Count}</strong></div>
              <div style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>{p.storageKey}</div>
            </div>
            <details>
              <summary style={{ fontSize: '11px', cursor: 'pointer', color: 'var(--rn-clr-content-secondary)' }}>
                Show raw entries ({p.entryCount})
              </summary>
              <pre style={preStyle}>{JSON.stringify(p.raw, null, 2)}</pre>
            </details>
          </div>
        ))}
      </div>

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Clean Inflated Page-History Durations
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handlePreviewInflationCleanup}
              disabled={isCleaningInflation}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isCleaningInflation ? 'wait' : 'pointer' }}
            >
              {isCleaningInflation ? 'Working…' : 'Preview'}
            </button>
            <button
              onClick={handleApplyInflationCleanup}
              disabled={isCleaningInflation || !inflationPreview}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', border: '1px solid var(--rn-clr-border-warning)', borderRadius: '4px', cursor: (isCleaningInflation || !inflationPreview) ? 'not-allowed' : 'pointer' }}
            >
              Apply
            </button>
          </div>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '8px' }}>
          Strips <code>sessionDuration</code> from page-history entries that don't match a rep in the IncRem/Dismissed
          history. Cutoff: <strong>2026-02-04</strong> (entries before that are preserved — rep history wasn't
          carried onto Dismissed before this date, so page-history may be the only record). Tolerance: ±5s timestamp,
          ±2s duration. Click Preview first; Apply rewrites storage.
        </div>
        {inflationPreview && inflationPreview.perPdf.map((p) => (
          <div key={p.pdfRemId} style={{ marginTop: '12px', padding: '8px', border: '1px solid var(--rn-clr-background-tertiary)', borderRadius: '4px' }}>
            <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: '6px' }}>
              📄 {p.pdfName} <span style={{ color: 'var(--rn-clr-content-tertiary)', fontWeight: 400 }}>({p.pdfRemId})</span>
            </div>
            <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: '6px' }}>
              <div>Before total: <strong>{formatDuration(p.beforeTotalSeconds)}</strong> ({p.beforeTotalSeconds}s)</div>
              <div>After total: <strong style={{ color: '#10b981' }}>{formatDuration(p.afterTotalSeconds)}</strong> ({p.afterTotalSeconds}s)</div>
              <div>Would strip: <strong style={{ color: p.stripCount > 0 ? '#ef4444' : 'inherit' }}>{p.stripCount}</strong> entries ({formatDuration(p.strippedSecondsTotal)})</div>
              <div>Would keep: <strong>{p.keptCount}</strong> entries ({formatDuration(p.keptSecondsTotal)})</div>
            </div>
            {p.stripped.length > 0 && (
              <details>
                <summary style={{ fontSize: '11px', cursor: 'pointer', color: '#ef4444' }}>
                  Entries to strip ({p.stripped.length})
                </summary>
                <pre style={preStyle}>{JSON.stringify(p.stripped.map(s => ({
                  index: s.index,
                  timestamp: s.timestamp,
                  date: dayjs(s.timestamp).format('YYYY-MM-DD HH:mm:ss'),
                  sessionDuration: s.sessionDuration,
                  reason: s.reason,
                })), null, 2)}</pre>
              </details>
            )}
            {p.preserved.length > 0 && (
              <details>
                <summary style={{ fontSize: '11px', cursor: 'pointer', color: '#10b981' }}>
                  Entries to keep ({p.preserved.length})
                </summary>
                <pre style={preStyle}>{JSON.stringify(p.preserved.map(s => ({
                  index: s.index,
                  timestamp: s.timestamp,
                  date: dayjs(s.timestamp).format('YYYY-MM-DD HH:mm:ss'),
                  sessionDuration: s.sessionDuration,
                  reason: s.reason,
                })), null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Clean Inflated Page-History — Global Scan
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleGlobalPreviewInflationCleanup}
              disabled={isGlobalCleaning}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isGlobalCleaning ? 'wait' : 'pointer' }}
            >
              {isGlobalCleaning ? 'Scanning…' : 'Scan All'}
            </button>
            <button
              onClick={handleGlobalApplyInflationCleanup}
              disabled={isGlobalCleaning || !globalInflationPreview || globalInflationPreview.totalStripCount === 0}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', border: '1px solid var(--rn-clr-border-warning)', borderRadius: '4px', cursor: (isGlobalCleaning || !globalInflationPreview || globalInflationPreview.totalStripCount === 0) ? 'not-allowed' : 'pointer' }}
            >
              Apply to All
            </button>
          </div>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '8px' }}>
          Scans every IncRem and Dismissed rem, applies the same cutoff/match logic, and aggregates the results.
          Same cutoff (<strong>2026-02-04 UTC</strong>) and tolerances (±5s timestamp, ±2s duration) as the per-rem
          cleanup above. Only rems with at least one strippable entry are shown.
        </div>
        {globalScanProgress && (
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>
            {globalScanProgress}
          </div>
        )}
        {globalInflationPreview && (
          <div>
            <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: '8px', padding: '8px', backgroundColor: 'var(--rn-clr-background-secondary)', borderRadius: '4px' }}>
              <div>Scanned: <strong>{globalInflationPreview.scannedRems}</strong> rems</div>
              <div>Affected: <strong>{globalInflationPreview.affectedRems}</strong> rems</div>
              <div>Entries to strip: <strong style={{ color: globalInflationPreview.totalStripCount > 0 ? '#ef4444' : 'inherit' }}>{globalInflationPreview.totalStripCount}</strong></div>
              <div>Total inflated time: <strong>{formatDuration(globalInflationPreview.totalStrippedSeconds)}</strong></div>
            </div>
            {globalInflationPreview.perRem.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#10b981' }}>✓ No inflated entries found across all rems.</div>
            ) : (
              globalInflationPreview.perRem.map((r) => (
                <details key={r.remId} style={{ marginTop: '8px', padding: '6px 8px', border: '1px solid var(--rn-clr-background-tertiary)', borderRadius: '4px' }}>
                  <summary style={{ fontSize: '12px', cursor: 'pointer' }}>
                    <span style={{ fontWeight: 600 }}>
                      [{r.remKind}] {r.remName}
                    </span>
                    <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: '8px', fontSize: '10px' }}>{r.remId}</span>
                    <span style={{ marginLeft: '8px', color: '#ef4444' }}>
                      strip {r.perPdf.reduce((s, p) => s + p.stripCount, 0)} ({formatDuration(r.perPdf.reduce((s, p) => s + p.strippedSecondsTotal, 0))})
                    </span>
                  </summary>
                  {r.perPdf.map((p) => (
                    <div key={p.pdfRemId} style={{ marginTop: '6px', marginLeft: '12px', padding: '6px', backgroundColor: 'var(--rn-clr-background-primary)', borderRadius: '4px' }}>
                      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>📄 {p.pdfName}</div>
                      <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
                        <div>Before: <strong>{formatDuration(p.beforeTotalSeconds)}</strong></div>
                        <div>After: <strong style={{ color: '#10b981' }}>{formatDuration(p.afterTotalSeconds)}</strong></div>
                        <div>Strip: <strong style={{ color: '#ef4444' }}>{p.stripCount}</strong> ({formatDuration(p.strippedSecondsTotal)})</div>
                        <div>Keep: <strong>{p.keptCount}</strong> ({formatDuration(p.keptSecondsTotal)})</div>
                      </div>
                    </div>
                  ))}
                </details>
              ))
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Synced Storage Key Audit
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleAuditSyncedKeys}
              disabled={isAuditingKeys}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isAuditingKeys ? 'wait' : 'pointer' }}
            >
              {isAuditingKeys ? 'Working…' : 'Scan Keys'}
            </button>
            <button
              onClick={handleProbeCapacity}
              disabled={isAuditingKeys}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isAuditingKeys ? 'wait' : 'pointer' }}
            >
              Test Capacity
            </button>
            <button
              onClick={handleCalibrateLimit}
              disabled={isAuditingKeys}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isAuditingKeys ? 'wait' : 'pointer' }}
            >
              Calibrate size ceiling
            </button>
            <button
              onClick={handleTestNullFreesSlot}
              disabled={isAuditingKeys || !keyAudit?.disposable?.length}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', border: '1px solid var(--rn-clr-border-warning)', borderRadius: '4px', cursor: (isAuditingKeys || !keyAudit?.disposable?.length) ? 'not-allowed' : 'pointer' }}
            >
              Does null free a slot?
            </button>
          </div>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '8px' }}>
          RemNote 1.27.16 caps a plugin at <strong>{SYNCED_KEY_CAP}</strong> synced keys and the SDK cannot enumerate
          them, so this reconstructs every key the plugin can write from the KB (IncRems × PDFs, documents, links,
          videos, …) and probes each with <code>getSynced</code>. <strong>live</strong> = holds a value,{' '}
          <strong>nulled</strong> = the key exists holding <code>null</code> (our "delete" pattern — still occupying a
          slot). Orphan keys whose rem was deleted can't be named; they show up as <em>unaccounted</em>. Sizes are the
          UTF-8 length of each value's JSON, measured against the {formatBytes(896 * 1024)} per-key ceiling (UTF-16, so
          double the UTF-8 figure) and the {formatBytes(10 * 1024 * 1024)} total budget. Every candidate costs
          one IPC read, so a large KB can take a few minutes and will feel sluggish while it runs. Full dump in console.
        </div>
        {keyAuditProgress && (
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>
            {keyAuditProgress}
          </div>
        )}
        {capacityReport && (
          <div style={{ fontSize: '12px', marginBottom: '8px', padding: '8px', borderRadius: '4px', backgroundColor: capacityReport.atCap ? 'var(--rn-clr-background-warning)' : 'var(--rn-clr-background-secondary)', color: capacityReport.atCap ? 'var(--rn-clr-content-warning)' : 'inherit' }}>
            {capacityReport.atCap
              ? `At cap — writing a new key was rejected. ${capacityReport.error ?? ''}`
              : 'Free capacity — a brand-new key was accepted (and released again).'}
          </div>
        )}
        {keyAudit && (
          <div>
            <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: '8px', padding: '8px', backgroundColor: 'var(--rn-clr-background-secondary)', borderRadius: '4px' }}>
              <div>Named keys occupying slots: <strong>{keyAudit.occupied}</strong> / {keyAudit.cap}</div>
              <div>Unaccounted (unnameable orphans): <strong style={{ color: keyAudit.unaccounted > 0 ? '#ef4444' : 'inherit' }}>~{keyAudit.unaccounted}</strong></div>
              <div>Live: <strong>{keyAudit.totals.live}</strong> · Nulled: <strong style={{ color: keyAudit.totals.nulled > 0 ? '#ef4444' : 'inherit' }}>{keyAudit.totals.nulled}</strong></div>
              <div>Probed: <strong>{keyAudit.totals.probed}</strong> candidate keys in {(keyAudit.durationMs / 1000).toFixed(1)}s</div>
              <div>
                Measured footprint: <strong>{formatBytes(keyAudit.totalBytes)}</strong> / {formatBytes(keyAudit.totalBudget)}{' '}
                ({((keyAudit.totalBytes / keyAudit.totalBudget) * 100).toFixed(1)}%)
              </div>
              <div>
                Biggest key: <strong style={{ color: keyAudit.sizeWarnings.length > 0 ? '#ef4444' : 'inherit' }}>
                  {keyAudit.largestKeys[0] ? formatBytes(keyAudit.largestKeys[0].bytes) : '—'}
                </strong> / {formatBytes(keyAudit.perKeyLimit)} per-key ceiling
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                Scanned: {keyAudit.scanned.allRems} rems ({keyAudit.scanned.incRems} IncRem ·{' '}
                {keyAudit.scanned.dismissed} Dismissed) · {keyAudit.scanned.pdfPairs} IncRem×PDF pairs ·{' '}
                {keyAudit.scanned.videoUrls} video URLs · {keyAudit.kbIds.length} KB id(s)
              </div>
            </div>
            {!keyAudit.nullSignalUsable && (
              <div style={{ fontSize: '12px', marginBottom: '8px', padding: '8px', borderRadius: '4px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)' }}>
                Calibration failed: a key that was never written did not read back as <code>undefined</code>, so
                "nulled" can't be told apart from "absent". That column is excluded from the occupied count — use the
                null-frees-slot experiment instead.
              </div>
            )}
            {keyAudit.sizeWarnings.length > 0 && (
              <div style={{ fontSize: '12px', marginBottom: '8px', padding: '8px', borderRadius: '4px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)' }}>
                <strong>{keyAudit.sizeWarnings.length}</strong> key(s) past half the {formatBytes(keyAudit.perKeyLimit)} per-key
                ceiling — these are the ones that need a retention window or restructuring, not migration:
                <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px' }}>
                  {keyAudit.sizeWarnings.map((k) => (
                    <li key={k.key} style={{ wordBreak: 'break-all' }}>
                      <code style={{ fontSize: '10px' }}>{k.key}</code> — {formatBytes(k.bytes)}{' '}
                      ({((k.bytes / keyAudit.perKeyLimit) * 100).toFixed(0)}%)
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {keyAudit.nullSignalUsable && keyAudit.totals.nulled > 0 && (
              <div style={{ fontSize: '12px', marginBottom: '8px', padding: '8px', borderRadius: '4px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)' }}>
                <strong>{keyAudit.totals.nulled}</strong> key(s) exist holding <code>null</code> — writing null does not
                delete the key, so every cleanup path in the plugin is leaking slots.
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ fontSize: '11px', width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                    <th style={{ padding: '4px' }}>Family</th>
                    <th style={{ padding: '4px', textAlign: 'right' }}>Live</th>
                    <th style={{ padding: '4px', textAlign: 'right' }}>Size</th>
                    <th style={{ padding: '4px', textAlign: 'right' }}>Largest</th>
                    <th style={{ padding: '4px', textAlign: 'right' }}>Nulled</th>
                    <th style={{ padding: '4px', textAlign: 'right' }}>Probed</th>
                    <th style={{ padding: '4px' }}>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {[...keyAudit.families]
                    .sort((a, b) => b.bytes - a.bytes || (b.live + b.nulled) - (a.live + a.nulled))
                    .map((f) => (
                      <tr key={f.family} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                        <td style={{ padding: '4px' }}>
                          <div style={{ fontWeight: 600 }}>{f.family}</div>
                          <code style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>{f.pattern}</code>
                          {f.note && (
                            <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', fontStyle: 'italic' }}>{f.note}</div>
                          )}
                        </td>
                        <td style={{ padding: '4px', textAlign: 'right', fontWeight: 600 }}>{f.live}</td>
                        <td style={{ padding: '4px', textAlign: 'right' }}>{f.bytes > 0 ? formatBytes(f.bytes) : '—'}</td>
                        <td style={{ padding: '4px', textAlign: 'right', color: f.largest && f.largest.bytes >= keyAudit.perKeyLimit * 0.5 ? '#ef4444' : 'var(--rn-clr-content-tertiary)' }}>
                          {f.largest ? formatBytes(f.largest.bytes) : '—'}
                        </td>
                        <td style={{ padding: '4px', textAlign: 'right', color: f.nulled > 0 ? '#ef4444' : 'inherit' }}>{f.nulled}</td>
                        <td style={{ padding: '4px', textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>{f.probed}</td>
                        <td style={{ padding: '4px', color: f.coverage === 'full' ? '#10b981' : 'var(--rn-clr-content-tertiary)' }}>{f.coverage}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {keyAudit.largestKeys.length > 0 && (
              <details style={{ marginTop: '8px' }}>
                <summary style={{ fontSize: '11px', cursor: 'pointer', color: 'var(--rn-clr-content-secondary)' }}>
                  Largest keys ({keyAudit.largestKeys.length}) — per-key ceiling {formatBytes(keyAudit.perKeyLimit)}
                </summary>
                <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', margin: '4px 0' }}>
                  UTF-8 / UTF-16 / re-escaped are the same value counted three ways. The ceiling was <em>measured</em> at{' '}
                  {formatBytes(896 * 1024)} counted in <strong>UTF-16</strong> bytes, so the UTF-8 column is half of what
                  the limit sees — <strong>% worst</strong> is the figure to act on. Re-run "Calibrate size ceiling" if
                  RemNote changes its storage layer again.
                </div>
                <table style={{ fontSize: '11px', width: '100%', borderCollapse: 'collapse', marginTop: '4px' }}>
                  <thead>
                    <tr style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>
                      <th style={{ padding: '3px 4px', textAlign: 'left' }}>Key</th>
                      <th style={{ padding: '3px 4px' }}>UTF-8</th>
                      <th style={{ padding: '3px 4px' }}>UTF-16</th>
                      <th style={{ padding: '3px 4px' }}>Escaped</th>
                      <th style={{ padding: '3px 4px' }}>% worst</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keyAudit.largestKeys.map((k) => {
                      const pct = (worstCaseBytes(k) / keyAudit.perKeyLimit) * 100;
                      return (
                        <tr key={k.key} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                          <td style={{ padding: '3px 4px', wordBreak: 'break-all' }}><code style={{ fontSize: '10px' }}>{k.key}</code></td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{formatBytes(k.bytes)}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>{k.utf16 != null ? formatBytes(k.utf16) : '—'}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>{k.escaped != null ? formatBytes(k.escaped) : '—'}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap', color: pct >= 100 ? '#ef4444' : pct >= 50 ? '#f59e0b' : 'var(--rn-clr-content-tertiary)' }}>
                            {pct.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        )}
        {limitReport && (
          <div style={{ marginTop: '8px', padding: '8px', border: '1px solid var(--rn-clr-background-tertiary)', borderRadius: '4px', fontSize: '11px' }}>
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>
              Per-key ceiling calibration — documented limit {formatBytes(limitReport.documentedLimit)}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '6px' }}>
              <thead>
                <tr style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>
                  <th style={{ padding: '3px 4px', textAlign: 'left' }}>Alphabet</th>
                  <th style={{ padding: '3px 4px' }}>Largest accepted</th>
                  <th style={{ padding: '3px 4px' }}>as UTF-8</th>
                  <th style={{ padding: '3px 4px' }}>as UTF-16</th>
                </tr>
              </thead>
              <tbody>
                {limitReport.probes.map((p) => (
                  <tr key={p.label} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                    <td style={{ padding: '3px 4px' }}>{p.label}</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right' }}>{p.acceptedChars.toLocaleString()} chars</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right' }}>{formatBytes(p.acceptedUtf8)}</td>
                    <td style={{ padding: '3px 4px', textAlign: 'right' }}>{formatBytes(p.acceptedUtf16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: '6px', borderRadius: '4px', backgroundColor: limitReport.unit === 'unknown' ? 'var(--rn-clr-background-warning)' : 'var(--rn-clr-background-secondary)', color: limitReport.unit === 'unknown' ? 'var(--rn-clr-content-warning)' : 'inherit' }}>
              {limitReport.verdict}
            </div>
          </div>
        )}
        <div style={{ marginTop: '8px', padding: '8px', border: '1px solid var(--rn-clr-background-tertiary)', borderRadius: '4px', fontSize: '11px' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>Key anatomy:</strong>
            <input
              value={anatomyKey}
              onChange={(e) => setAnatomyKey(e.target.value)}
              style={{ fontSize: '11px', padding: '2px 6px', flex: '1 1 220px', minWidth: '160px', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px' }}
            />
            <button
              onClick={handleAnalyzeKey}
              disabled={isAuditingKeys}
              style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isAuditingKeys ? 'wait' : 'pointer' }}
            >
              Break it down
            </button>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', marginTop: '4px' }}>
            Reads one array-valued key and reports where its bytes go — entries, cost per field, fattest entries, and
            what capping the entry count or the stored text would save.
          </div>
          {currentKbId && (
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>This KB’s shards:</span>
              {[
                { label: 'Flashcard history', key: shardKey(flashcardHistorySpec, currentKbId) },
                { label: 'Visited rems', key: shardKey(remHistorySpec, currentKbId) },
              ].map(({ label, key }) => (
                <button
                  key={key}
                  onClick={() => setAnatomyKey(key)}
                  style={{ fontSize: '10px', padding: '1px 6px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: 'pointer' }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {anatomy && (
            <div style={{ marginTop: '8px' }}>
              {!anatomy.exists ? (
                <div>Key is absent or null.</div>
              ) : anatomy.shape === 'object' ? (
                <>
                  <div style={{ marginBottom: '6px' }}>
                    <strong>{anatomy.branches.length}</strong> branch(es)
                    {anatomy.branchRoot && <> under <code style={{ fontSize: '10px' }}>{anatomy.branchRoot}</code></>}{' '}
                    holding <strong>{anatomy.entries}</strong> rows · {formatBytes(anatomy.size.utf8)} UTF-8 ·{' '}
                    <span style={{ color: anatomy.worst >= anatomy.perKeyLimit ? '#ef4444' : anatomy.worst >= anatomy.perKeyLimit * 0.5 ? '#f59e0b' : 'inherit', fontWeight: 600 }}>
                      worst case {formatBytes(anatomy.worst)} ({((anatomy.worst / anatomy.perKeyLimit) * 100).toFixed(0)}% of ceiling)
                    </span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '6px' }}>
                    <thead>
                      <tr style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>
                        <th style={{ padding: '3px 4px', textAlign: 'left' }}>Branch</th>
                        <th style={{ padding: '3px 4px' }}>Rows</th>
                        <th style={{ padding: '3px 4px' }}>Size</th>
                        <th style={{ padding: '3px 4px' }}>Share</th>
                        <th style={{ padding: '3px 4px' }}>Span</th>
                      </tr>
                    </thead>
                    <tbody>
                      {anatomy.branches.map((b) => (
                        <tr key={b.path} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                          <td style={{ padding: '3px 4px', wordBreak: 'break-all' }}><code style={{ fontSize: '10px' }}>{b.path}</code></td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>{b.children}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>{formatBytes(b.bytes)}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', fontWeight: b.share >= 0.5 ? 600 : 400 }}>{(b.share * 100).toFixed(1)}%</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--rn-clr-content-tertiary)' }}>
                            {b.firstChildKey ? `${b.firstChildKey} → ${b.lastChildKey}` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {anatomy.projections.length > 0 && (
                    <>
                      <div style={{ fontWeight: 600, marginBottom: '2px' }}>What would shrink it</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>
                          {anatomy.projections.map((p) => (
                            <tr key={p.label} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                              <td style={{ padding: '3px 4px' }}>{p.label}</td>
                              <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>{formatBytes(p.utf8)} UTF-8</td>
                              <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                worst {formatBytes(p.worst)} ({((p.worst / anatomy.perKeyLimit) * 100).toFixed(0)}%)
                              </td>
                              <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap', color: '#10b981' }}>−{(p.savedPct * 100).toFixed(0)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </>
              ) : !anatomy.isArray ? (
                <div>
                  Neither an array nor an object map — {formatBytes(anatomy.size.utf8)} UTF-8 /{' '}
                  {formatBytes(anatomy.size.utf16)} UTF-16 / {formatBytes(anatomy.size.escaped)} re-escaped.
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '6px' }}>
                    <strong>{anatomy.entries}</strong> entries · {formatBytes(anatomy.size.utf8)} UTF-8 ·{' '}
                    {formatBytes(anatomy.size.utf16)} UTF-16 ·{' '}
                    <span style={{ color: anatomy.worst >= anatomy.perKeyLimit ? '#ef4444' : anatomy.worst >= anatomy.perKeyLimit * 0.5 ? '#f59e0b' : 'inherit', fontWeight: 600 }}>
                      worst case {formatBytes(anatomy.worst)} ({((anatomy.worst / anatomy.perKeyLimit) * 100).toFixed(0)}% of ceiling)
                    </span>
                    {anatomy.oldest && anatomy.newest && (
                      <> · spans {Math.round((anatomy.newest - anatomy.oldest) / 86400000)} days</>
                    )}
                  </div>
                  <div style={{ marginBottom: '6px', color: 'var(--rn-clr-content-secondary)' }}>
                    Per entry — avg {formatBytes(anatomy.entryBytes.avg)}, median {formatBytes(anatomy.entryBytes.median)},
                    p95 {formatBytes(anatomy.entryBytes.p95)}, max {formatBytes(anatomy.entryBytes.max)}
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '6px' }}>
                    <thead>
                      <tr style={{ textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>
                        <th style={{ padding: '3px 4px', textAlign: 'left' }}>Field</th>
                        <th style={{ padding: '3px 4px' }}>Total</th>
                        <th style={{ padding: '3px 4px' }}>Share</th>
                        <th style={{ padding: '3px 4px' }}>Present</th>
                        <th style={{ padding: '3px 4px' }}>Fattest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {anatomy.fields.map((f) => (
                        <tr key={f.field} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                          <td style={{ padding: '3px 4px' }}><code style={{ fontSize: '10px' }}>{f.field}</code></td>
                          <td style={{ padding: '3px 4px', textAlign: 'right' }}>{formatBytes(f.bytes)}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', fontWeight: f.share >= 0.3 ? 600 : 400 }}>{(f.share * 100).toFixed(1)}%</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>{f.present}/{anatomy.entries}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>{formatBytes(f.longest)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {anatomy.distributions.map((dist) => (
                    <details key={dist.field} style={{ marginBottom: '6px' }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--rn-clr-content-secondary)' }}>
                        Split by <code style={{ fontSize: '10px' }}>{dist.field}</code> ({dist.values.length} distinct) —
                        would sharding on it help?
                      </summary>
                      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '4px' }}>
                        <tbody>
                          {dist.values.slice(0, 25).map((v) => (
                            <tr key={v.value} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                              <td style={{ padding: '3px 4px', wordBreak: 'break-all' }}><code style={{ fontSize: '10px' }}>{v.value}</code></td>
                              <td style={{ padding: '3px 4px', textAlign: 'right', color: 'var(--rn-clr-content-tertiary)' }}>{v.count} entries</td>
                              <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>{formatBytes(v.bytes)}</td>
                              <td style={{ padding: '3px 4px', textAlign: 'right', fontWeight: v.share >= 0.5 ? 600 : 400 }}>{(v.share * 100).toFixed(1)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ))}
                  <div style={{ fontWeight: 600, marginBottom: '2px' }}>If we trimmed it</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {anatomy.projections.map((p) => (
                        <tr key={p.label} style={{ borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                          <td style={{ padding: '3px 4px' }}>{p.label}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>{formatBytes(p.utf8)} UTF-8</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            worst {formatBytes(p.worst)} ({((p.worst / anatomy.perKeyLimit) * 100).toFixed(0)}%)
                          </td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap', color: '#10b981' }}>−{(p.savedPct * 100).toFixed(0)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
        {nullTestReport && (
          <div style={{ marginTop: '8px', padding: '8px', border: '1px solid var(--rn-clr-background-tertiary)', borderRadius: '4px', fontSize: '11px' }}>
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>
              null-frees-slot test — sacrificed <code>{nullTestReport.sacrificedKey}</code>
              {nullTestReport.restored ? ' (restored)' : ' (NOT restored — see console)'}
            </div>
            <ol style={{ margin: 0, paddingLeft: '18px' }}>
              {nullTestReport.steps.map((s, i) => (
                <li key={i} style={{ marginBottom: '2px' }}>{s}</li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Search / Linkage Diagnostics
          <button
            onClick={handleSearchProbe}
            disabled={isProbingSearch}
            style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isProbingSearch ? 'wait' : 'pointer' }}
          >
            {isProbingSearch ? 'Probing…' : 'Probe Searchability'}
          </button>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '8px' }}>
          Diagnoses why this rem may be invisible in reference search. Reproduces the editor's search via
          <code> plugin.search.search()</code>, inspects the rem's own literal text, Unicode normalization, hidden
          characters, type/flags, aliases and ranking. Run on a working rem and a broken one to compare. Full dump in console.
        </div>
        {searchProbe && (
          <div>
            <div style={{ marginBottom: '8px', padding: '8px', backgroundColor: searchProbe.issues.length > 0 && searchProbe.literalCharCount > 0 && !searchProbe.nfcDiffers && searchProbe.suspiciousChars.length === 0 ? 'var(--rn-clr-background-secondary)' : 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', borderRadius: '4px', fontSize: '12px', border: '1px solid var(--rn-clr-border-warning)' }}>
              <strong>Verdict:</strong>
              <ul style={{ margin: '6px 0 0 0', paddingLeft: '18px' }}>
                {searchProbe.issues.map((issue, i) => (
                  <li key={i} style={{ marginBottom: '4px' }}>{issue}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-4 mb-2" style={{ flexWrap: 'wrap' }}>
              <Info className="" label="Type" data={searchProbe.typeLabel} />
              <Info className="" label="Literal chars (own text)" data={<strong style={{ color: searchProbe.literalCharCount === 0 ? '#ef4444' : 'inherit' }}>{searchProbe.literalCharCount}</strong>} />
              <Info className="" label="timesSelectedInSearch" data={searchProbe.timesSelectedInSearch ?? '—'} />
              <Info className="" label="Referenced by" data={searchProbe.referencedByCount} />
              <Info className="" label="References" data={searchProbe.referencesCount} />
            </div>
            <div className="flex gap-4 mb-2" style={{ flexWrap: 'wrap' }}>
              <Info className="" label="NFC normalized?" data={searchProbe.isNFC ? <span style={{ color: '#22c55e' }}>Yes</span> : <span style={{ color: '#ef4444', fontWeight: 600 }}>NO — accents decomposed</span>} />
              <Info className="" label="Leading/trailing WS" data={searchProbe.hasLeadingTrailingWhitespace ? <span style={{ color: '#ef4444', fontWeight: 600 }}>YES</span> : 'No'} />
              <Info className="" label="Hidden/zero-width chars" data={<strong style={{ color: searchProbe.suspiciousChars.length > 0 ? '#ef4444' : 'inherit' }}>{searchProbe.suspiciousChars.length}</strong>} />
            </div>
            <Info className="" label={`Plain string ("${searchProbe.plainString}")`} data={<code>{JSON.stringify(searchProbe.plainString)}</code>} />
            {searchProbe.suspiciousChars.length > 0 && (
              <Info className="" label="Suspicious characters" data={<pre style={preStyle}>{JSON.stringify(searchProbe.suspiciousChars, null, 2)}</pre>} />
            )}
            <Info className="" label="Active flags" data={
              <span style={{ fontSize: '11px' }}>
                {Object.entries(searchProbe.flags).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}
              </span>
            } />
            <Info className="" label="Own-text search rank (top 50)" data={
              <span>
                <span style={{ color: searchProbe.ownSearchRank === -1 ? '#ef4444' : '#22c55e', fontWeight: 600 }}>
                  {searchProbe.ownSearchRank === -1 ? `NOT FOUND (in ${searchProbe.ownSearchCount})` : `#${searchProbe.ownSearchRank + 1}`}
                </span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: '8px', fontSize: '11px' }}>
                  concepts-only: {searchProbe.conceptSearchRank === -1 ? 'NOT FOUND' : `#${searchProbe.conceptSearchRank + 1}`}
                </span>
              </span>
            } />
            <Info className="" label="Deep search rank (top 1000)" data={
              <span>
                <span style={{ color: searchProbe.deepSearchRank === -1 ? '#ef4444' : '#f59e0b', fontWeight: 600 }}>
                  {searchProbe.deepSearchRank === -1 ? `NOT FOUND (in ${searchProbe.deepSearchCount})` : `#${searchProbe.deepSearchRank + 1}`}
                </span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: '8px', fontSize: '11px' }}>
                  concepts-only: {searchProbe.deepConceptRank === -1 ? 'NOT FOUND' : `#${searchProbe.deepConceptRank + 1}`}
                </span>
                <span style={{ color: 'var(--rn-clr-content-tertiary)', marginLeft: '8px', fontSize: '10px' }}>
                  {searchProbe.deepSearchRank !== -1 && searchProbe.ownSearchRank === -1 ? '← indexed, just out-ranked → re-ranking picker fixes it' : ''}
                </span>
              </span>
            } />
            {searchProbe.aliasSearches.length > 0 && (
              <Info className="" label="Found under alias?" data={
                <span style={{ fontSize: '11px' }}>
                  {searchProbe.aliasSearches.map((a) => (
                    <span key={a.aliasId} style={{ marginRight: '10px', color: a.rank === -1 ? '#ef4444' : '#22c55e' }}>
                      "{a.aliasText}": {a.rank === -1 ? 'no' : `#${a.rank + 1}`}
                    </span>
                  ))}
                </span>
              } />
            )}
            {searchProbe.prefixSearches.length > 0 && (
              <Info className="" label="Found under prefix?" data={
                <span style={{ fontSize: '11px' }}>
                  {searchProbe.prefixSearches.map((p) => (
                    <span key={p.query} style={{ marginRight: '10px', color: p.rank === -1 ? '#ef4444' : '#22c55e' }}>
                      "{p.query}": {p.rank === -1 ? 'no' : `#${p.rank + 1}`}
                    </span>
                  ))}
                </span>
              } />
            )}
            {searchProbe.duplicates.length > 0 && (
              <Info className="" label="⚠️ Duplicate same-name rems" data={<pre style={preStyle}>{JSON.stringify(searchProbe.duplicates, null, 2)}</pre>} />
            )}
            {searchProbe.suspiciousAncestorPowerups.length > 0 && (
              <Info className="" label="⚠️ Search-excluding ancestor powerups" data={<span style={{ color: '#ef4444', fontWeight: 600 }}>{searchProbe.suspiciousAncestorPowerups.join(', ')}</span>} />
            )}
            <div className="flex gap-4 mb-2" style={{ flexWrap: 'wrap' }}>
              <Info className="" label="Own hidden state" data={searchProbe.ownHiddenState ?? 'none'} />
              <Info className="" label="In portals/docs" data={searchProbe.inPortalsCount} />
            </div>
            <details open={searchProbe.suspiciousAncestorPowerups.length > 0}>
              <summary style={{ fontSize: '11px', cursor: 'pointer', color: searchProbe.suspiciousAncestorPowerups.length > 0 ? '#ef4444' : 'var(--rn-clr-content-secondary)' }}>
                Ancestor chain ({searchProbe.ancestors.length}, parent → root)
              </summary>
              <pre style={preStyle}>{searchProbe.ancestors.map((a, i) =>
                `${i === searchProbe.ancestors.length - 1 ? '[ROOT] ' : ''}[${a.type}]${a.isDocument ? '📄' : ''} "${a.text}" (${a.id})` +
                `${a.powerups.length ? ` ⟨${a.powerups.join(', ')}⟩` : ''}` +
                `${a.portalType ? ` portal:${a.portalType}` : ''}` +
                `${a.hidden && a.hidden !== 'none' ? ` hidden:${a.hidden}` : ''}`
              ).join('\n')}</pre>
            </details>
            {searchProbe.aliases.length > 0 && (
              <Info className="" label="Aliases" data={<pre style={preStyle}>{JSON.stringify(searchProbe.aliasStructure.length ? searchProbe.aliasStructure : searchProbe.aliases, null, 2)}</pre>} />
            )}
            <details>
              <summary style={{ fontSize: '11px', cursor: 'pointer', color: 'var(--rn-clr-content-secondary)' }}>Element breakdown ({searchProbe.elements.length})</summary>
              <pre style={preStyle}>{searchProbe.elements.map((e) => `[${e.idx}] ${e.kind}: ${e.detail}`).join('\n')}</pre>
            </details>
            <details>
              <summary style={{ fontSize: '11px', cursor: 'pointer', color: 'var(--rn-clr-content-secondary)' }}>Code points ({searchProbe.codePoints.length})</summary>
              <pre style={preStyle}>{searchProbe.codePoints.map((c) => `${c.codePoint} ${JSON.stringify(c.char)}`).join('\n')}</pre>
            </details>
          </div>
        )}
      </div>

      {/* ── KB-wide diagnostics — kept BELOW the per-Rem sections ─────────────
          Settings migration, the shield history, and the CardPriority tag audit
          all describe the knowledge base, not the focused Rem. They used to sit
          directly under "General Data", pushing the Incremental / Card Priority
          readouts — the reason this widget gets opened — below the fold. */}
      {/* Durable status of the settings migration — which settings were carried
          into the plugin's own store, which failed, and whether it is done. */}
      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
          Settings Migration Status
          <span style={{ display: 'flex', gap: '6px' }}>
            <button onClick={handleShowMigrationStatus} disabled={isMigrating} style={{ ...smallBtnStyle, cursor: isMigrating ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              {isMigrating ? 'Working…' : 'Load status'}
            </button>
            <button onClick={handleCopyMigrationReport} style={{ ...smallBtnStyle, whiteSpace: 'nowrap' }}>Copy</button>
            <button onClick={handleForceRemigrate} disabled={isMigrating} style={{ ...smallBtnStyle, cursor: isMigrating ? 'wait' : 'pointer', whiteSpace: 'nowrap' }} title="Re-read every setting and overwrite the stored values. Use only to recover a migration that ran while settings were unreadable.">
              Force re-run
            </button>
          </span>
        </h2>
        <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>
          The migration copies each setting out of RemNote's settings panel into the plugin's own synced storage. It
          runs once on load and records the outcome per setting, so this stays readable afterwards. Full detail also
          goes to the DevTools console.
        </div>
        {migrationReport === null ? (
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)' }}>
            Press "Load status" — nothing loaded yet in this widget.
          </div>
        ) : (
          <div style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)', backgroundColor: 'var(--rn-clr-background-secondary)', fontSize: '11px' }}>
            <div style={{ lineHeight: 1.6, marginBottom: '6px' }}>
              <div>
                Status:{' '}
                <strong style={{ color: migrationReport.complete ? '#16a34a' : '#ef4444' }}>
                  {migrationReport.complete
                    ? 'COMPLETE'
                    : migrationReport.gaveUp
                      ? 'INCOMPLETE — retries exhausted'
                      : 'INCOMPLETE — retries on next reload'}
                </strong>
              </div>
              <div>Last run: {new Date(migrationReport.finishedAt).toLocaleString()} (attempt {migrationReport.attempt})</div>
              <div>
                {migrationReport.total} settings — <strong>{migrationReport.counts.migrated}</strong> carried over,{' '}
                {migrationReport.counts.default} at default, {migrationReport.counts['already-present']} already stored,{' '}
                <strong style={{ color: migrationReport.counts.failed ? '#ef4444' : 'inherit' }}>
                  {migrationReport.counts.failed} failed
                </strong>
              </div>
            </div>
            {storedSettings && (
              <div style={{ marginBottom: '6px', paddingBottom: '6px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                <div style={{ fontWeight: 600, marginBottom: '2px' }}>
                  Stored blob — {Object.keys(storedSettings).length} key(s)
                </div>
                <div style={{ color: 'var(--rn-clr-content-tertiary)', marginBottom: '4px' }}>
                  Only settings that differ from their default are stored; everything else resolves through the
                  defaults table, so changing a default still reaches you.
                </div>
                {Object.keys(storedSettings).length === 0 ? (
                  <div style={{ color: 'var(--rn-clr-content-tertiary)' }}>(empty — every setting is at its default)</div>
                ) : (
                  Object.entries(storedSettings).map(([k, v]) => (
                    <div key={k} style={{ lineHeight: 1.5, paddingLeft: '6px' }}>
                      <code>{k}</code> → <strong>{JSON.stringify(v)}</strong>
                    </div>
                  ))
                )}
              </div>
            )}
            <div style={{ maxHeight: '260px', overflowY: 'auto', paddingTop: '6px', borderTop: '1px solid var(--rn-clr-background-tertiary)' }}>
              {migrationReport.records.map((r) => (
                <div key={r.id} style={{ lineHeight: 1.5 }}>
                  <span style={{ color: r.status === 'failed' ? '#ef4444' : r.status === 'migrated' || r.status === 'converted' ? '#16a34a' : 'var(--rn-clr-content-tertiary)' }}>
                    {r.status === 'failed' ? '✗' : r.status === 'converted' ? '~' : r.status === 'migrated' ? '●' : '·'}
                  </span>{' '}
                  <code>{r.id}</code> → <strong>{JSON.stringify(r.value)}</strong>{' '}
                  <span style={{ color: 'var(--rn-clr-content-tertiary)' }}>[{r.status}]</span>
                  {r.error && <div style={{ paddingLeft: '14px', color: '#ef4444' }}>{r.error}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Settings-migration probe: how does getSetting behave for ids this
          plugin no longer registers? Decides whether a one-time seed can read
          legacy values after the old registrations are deleted. */}
      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Settings Migration Probe
          <button
            onClick={handleProbeSettingsPersistence}
            disabled={isProbingSettings}
            style={{ ...smallBtnStyle, cursor: isProbingSettings ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
            title="Reads registered, never-registered and de-registered setting ids to see whether stored values outlive their registration"
          >
            {isProbingSettings ? 'Probing…' : 'Probe getSetting'}
          </button>
        </h2>
        <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>
          Checks whether <code>getSetting</code> returns <code>undefined</code> or throws for an unknown id, and whether
          values stored for settings the plugin used to register are still readable now that it doesn't.
        </div>
        {settingsProbe && (
          <div style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)', backgroundColor: 'var(--rn-clr-background-secondary)', fontSize: '11px' }}>
            {(['control', 'never-registered', 'de-registered'] as const).map((group) => (
              <div key={group} style={{ marginBottom: '8px' }}>
                <div style={{ fontWeight: 600, marginBottom: '2px' }}>{group}</div>
                {settingsProbe.rows.filter((r) => r.group === group).map((r) => (
                  <div key={r.id} style={{ lineHeight: 1.5, paddingLeft: '6px' }}>
                    <code>{r.id}</code> →{' '}
                    <strong style={{ color: r.outcome === 'threw' ? '#ef4444' : r.outcome === 'value' ? '#16a34a' : '#d97706' }}>
                      {r.value}
                    </strong>
                    {r.error && <div style={{ paddingLeft: '6px', color: '#ef4444' }}>{r.error}</div>}
                    <div style={{ paddingLeft: '6px', color: 'var(--rn-clr-content-tertiary)' }}>{r.note}</div>
                  </div>
                ))}
              </div>
            ))}
            <div style={{ paddingTop: '6px', borderTop: '1px solid var(--rn-clr-background-tertiary)', lineHeight: 1.6 }}>
              <div>
                Unknown id: <strong>{settingsProbe.anyThrew ? 'THROWS — seed needs per-id try/catch' : 'returns undefined — safe to call'}</strong>
              </div>
              <div>
                De-registered ids still holding a value:{' '}
                <strong>
                  {settingsProbe.rows.filter((r) => r.group === 'de-registered' && r.outcome === 'value').length}
                  /{settingsProbe.rows.filter((r) => r.group === 'de-registered').length}
                </strong>
              </div>
              <div style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                Only a value differing from the old default is conclusive — an unset setting and a pruned one both read
                as <code>(undefined)</code>.
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          Priority Shield History (KB-wide)
          <button
            onClick={handleDumpShieldHistory}
            disabled={isDumpingShield}
            style={{ fontSize: '11px', padding: '2px 8px', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', cursor: isDumpingShield ? 'wait' : 'pointer' }}
          >
            {isDumpingShield ? 'Dumping…' : 'Dump + Export Shield History'}
          </button>
        </h2>
        <div style={{ fontSize: '12px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '8px' }}>
          Reads all four shield-history synced keys (IncRem/Card × KB/Doc, plus weighted variants) and the live
          write-side inputs used at QueueExit. Diagnoses whether Card shield history is <strong>empty</strong>,{' '}
          <strong>orphaned</strong> under a stale KB id, or simply not being written because the cardPriority cache
          is empty. Full raw JSON is logged to the console, copied to the clipboard, and downloaded as a file.
        </div>
        {shieldDump && (
          <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)', backgroundColor: 'var(--rn-clr-background-secondary)' }}>
            <div style={{ fontSize: '11px', marginBottom: '8px' }}>
              Current KB: <code>{shieldDump.currentKbId}</code> · isPrimary: <strong>{String(shieldDump.isPrimary)}</strong>
            </div>
            {shieldDump.stores.map((s) => {
              const color =
                s.status === 'ok' ? '#10b981'
                : s.status === 'orphaned' ? '#ef4444'
                : s.status === 'legacy' ? '#d97706'
                : s.status === 'empty' ? '#ef4444'
                : 'var(--rn-clr-content-tertiary)';
              return (
                <div key={s.key} style={{ marginBottom: '8px', paddingBottom: '6px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600 }}>
                    {s.label} <span style={{ color, textTransform: 'uppercase', fontSize: '10px' }}>[{s.status}]</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginTop: '2px' }}>{s.verdict}</div>
                  <div style={{ fontSize: '10px', color: 'var(--rn-clr-content-tertiary)', marginTop: '2px' }}>
                    current-KB: {s.currentKbDatedEntries} · orphaned: {s.otherKbPartitions.reduce((a, p) => a + p.entryCount, 0)} · legacy-root: {s.legacyRootDatedEntries}
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '8px', marginBottom: '4px' }}>Live write-side inputs</div>
            <div style={{ fontSize: '11px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
              <div>cardPriority cache: <strong style={{ color: shieldDump.live.allCardInfos === 0 ? '#ef4444' : 'inherit' }}>{shieldDump.live.allCardInfos}</strong></div>
              <div>incRem cache: <strong>{shieldDump.live.allIncRems}</strong></div>
              <div>cardPriority taggedRem(): <strong style={{ color: shieldDump.live.cardPriorityTaggedRems === 0 ? '#ef4444' : 'inherit' }}>{shieldDump.live.cardPriorityTaggedRems}</strong></div>
              <div>with priority: <strong>{shieldDump.live.cardInfosWithPriority}</strong></div>
              <div>with dueCardsOverdue field: <strong>{shieldDump.live.cardInfosWithDueOverdue}</strong></div>
              <div>currently due-overdue: <strong>{shieldDump.live.cardInfosDueOverdue}</strong></div>
              <div>card cache loaded flag: <strong>{String(shieldDump.live.cardCacheLoaded)}</strong></div>
              <div>incRem cache loaded flag: <strong>{String(shieldDump.live.incRemCacheLoaded)}</strong></div>
              <div>seen cards (session): <strong>{shieldDump.live.seenCardIds}</strong></div>
              <div>seen rems (session): <strong>{shieldDump.live.seenRemIds}</strong></div>
            </div>
            <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '8px', marginBottom: '4px' }}>Serialized size per key (sync-limit suspects)</div>
            <div style={{ fontSize: '11px' }}>
              {shieldDump.keySizes.map((k) => (
                <div key={k.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                  <span style={{ color: 'var(--rn-clr-content-secondary)' }}>{k.label}</span>
                  <strong style={{ color: k.approxKB >= 100 ? '#ef4444' : k.approxKB >= 50 ? '#d97706' : 'inherit' }}>
                    {k.chars.toLocaleString()} chars (~{k.approxKB} KB)
                  </strong>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mobile-safe export: on Android the file download and clipboard API silently
            fail, so render the JSON on-screen to select/copy manually. */}
        {shieldExport && (
          <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--rn-clr-background-tertiary)' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              Copyable export (for mobile / when the file didn't save)
              <button onClick={handleSnapshotToSyncedBackup} style={smallBtnStyle} title="Save this device's card history to a synced backup key that syncs up on reconnect and appears under Restore → Load backups elsewhere">
                Snapshot → synced backup
              </button>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>
              Tap a box to select all, or use its Copy button, then paste into the Restore box on another device.
              The <strong>card-only</strong> export is smaller and is all you need to recover the lost card history.
              Or use <strong>Snapshot → synced backup</strong>: it saves this device's card history under a new synced
              key that pushes up when you reconnect (no copy/paste), then restore it elsewhere via "Load backups".
            </div>
            {([
              { label: 'Card-only export', text: shieldExport.cardOnly },
              { label: 'Full export', text: shieldExport.full },
            ] as const).map(({ label, text }) => (
              <div key={label} style={{ marginBottom: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600 }}>{label} <span style={{ color: 'var(--rn-clr-content-tertiary)', fontWeight: 400 }}>({(text.length / 1024).toFixed(1)} KB)</span></span>
                  <button onClick={() => copyTextFallback(text)} style={smallBtnStyle}>Copy</button>
                </div>
                <textarea
                  readOnly
                  value={text}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.currentTarget.select()}
                  style={{ width: '100%', minHeight: '54px', fontSize: '9px', fontFamily: 'monospace', padding: '6px', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)', boxSizing: 'border-box', whiteSpace: 'pre', overflowWrap: 'normal' }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Locate the rem named in a "Diff for <remId> is too large to sync" error. */}
        <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--rn-clr-background-tertiary)' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>Locate a "too large to sync" rem</div>
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>
            Paste the rem id from a <code>Diff for &lt;remId&gt; is too large to sync</code> error. Reports what that rem
            is, its text size, and — if it holds JSON — its top-level keys, so we can tell whether the stranded
            shield history lives inside it.
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              value={syncRemIdInput}
              onChange={(e) => setSyncRemIdInput(e.target.value)}
              placeholder="remId"
              style={{ flex: 1, fontSize: '11px', padding: '3px 6px', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)', fontFamily: 'monospace' }}
            />
            <button onClick={handleProbeSyncRem} disabled={isProbingSyncRem} style={{ ...smallBtnStyle, cursor: isProbingSyncRem ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
              {isProbingSyncRem ? 'Probing…' : 'Inspect Rem'}
            </button>
          </div>
          {syncRemProbe && (
            <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)', backgroundColor: 'var(--rn-clr-background-secondary)', fontSize: '11px' }}>
              {!syncRemProbe.found ? (
                <div style={{ color: '#d97706' }}>
                  <code>{syncRemProbe.remId}</code> — not readable via the plugin API (likely an internal storage doc
                  owned by RemNote or another plugin). Use RemNote's own "resolve" flow for it.
                </div>
              ) : (
                <div style={{ lineHeight: 1.6 }}>
                  <div><code>{syncRemProbe.remId}</code></div>
                  <div>Text size: <strong style={{ color: syncRemProbe.textChars >= 100 * 1024 ? '#ef4444' : 'inherit' }}>{syncRemProbe.textChars.toLocaleString()} chars</strong> (~{Math.round((syncRemProbe.textChars / 1024) * 10) / 10} KB)</div>
                  <div>Powerups: <strong>{syncRemProbe.remType}</strong></div>
                  <div>Looks like JSON: <strong>{String(syncRemProbe.looksLikeJson)}</strong></div>
                  {syncRemProbe.jsonTopKeysPreview && (
                    <div>JSON top keys: <span style={{ fontFamily: 'monospace', color: 'var(--rn-clr-content-secondary)' }}>{syncRemProbe.jsonTopKeysPreview.join(', ')}</span></div>
                  )}
                  <div>Parent: <span style={{ color: 'var(--rn-clr-content-secondary)' }}>{syncRemProbe.parentText ?? '(none)'}</span></div>
                  {syncRemProbe.ancestorTexts.length > 0 && (
                    <div>Ancestors: <span style={{ color: 'var(--rn-clr-content-secondary)' }}>{syncRemProbe.ancestorTexts.join(' › ')}</span></div>
                  )}
                  <div>Children: <strong>{syncRemProbe.childCount}</strong></div>
                  {syncRemProbe.textPreview && (
                    <pre style={preStyle}>{syncRemProbe.textPreview}</pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Restore shield history from a cleanup backup or a pasted export/backup JSON. */}
        <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--rn-clr-background-tertiary)' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            Restore Shield History
            <button onClick={handleLoadBackups} style={smallBtnStyle}>Load backups</button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>
            Merges history back into the live store. It is <strong>additive</strong> — an existing day is never
            overwritten, so current data is safe. Source can be a cleanup backup (auto-saved before "Remove All
            CardPriority Tags") or a JSON export from another device.
          </div>

          {backupList && (
            backupList.length === 0 ? (
              <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>No cleanup backups found on this account.</div>
            ) : (
              <div style={{ marginBottom: '8px' }}>
                {backupList.map((b) => (
                  <div key={b.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '11px', padding: '4px 0', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{b.backedUpAt ? dayjs(b.backedUpAt).format('MMM D, YYYY HH:mm') : '(undated)'} · {b.dateEntries} entr(ies)</div>
                      <div style={{ color: 'var(--rn-clr-content-tertiary)', fontFamily: 'monospace', fontSize: '10px' }}>KB {b.kbId ?? '?'}</div>
                    </div>
                    <button onClick={() => handleRestoreFromBackupKey(b.key)} disabled={isRestoring} style={{ ...smallBtnStyle, cursor: isRestoring ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
                      {isRestoring ? 'Restoring…' : 'Restore'}
                    </button>
                  </div>
                ))}
              </div>
            )
          )}

          <textarea
            value={restoreJsonInput}
            onChange={(e) => setRestoreJsonInput(e.target.value)}
            placeholder="Paste a shield-dump export or backup JSON here…"
            style={{ width: '100%', minHeight: '60px', fontSize: '10px', fontFamily: 'monospace', padding: '6px', border: '1px solid var(--rn-clr-border)', borderRadius: '4px', backgroundColor: 'var(--rn-clr-background-primary)', color: 'var(--rn-clr-content-primary)', boxSizing: 'border-box' }}
          />
          <div style={{ marginTop: '6px' }}>
            <button onClick={handleRestoreFromJson} disabled={isRestoring || !restoreJsonInput.trim()} style={{ ...smallBtnStyle, cursor: (isRestoring || !restoreJsonInput.trim()) ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: (isRestoring || !restoreJsonInput.trim()) ? 0.5 : 1 }}>
              {isRestoring ? 'Restoring…' : 'Restore from JSON'}
            </button>
          </div>

          {restoreResult && (
            <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)', backgroundColor: 'var(--rn-clr-background-secondary)', fontSize: '11px' }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>Restored from {restoreResult.source}</div>
              {restoreResult.perKey.map((p) => (
                <div key={p.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                  <span style={{ color: 'var(--rn-clr-content-secondary)', fontFamily: 'monospace', fontSize: '10px' }}>{p.key}</span>
                  <strong style={{ color: p.added > 0 ? '#10b981' : 'inherit' }}>+{p.added} added, {p.skipped} kept</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {tagAudit && (
        <div style={{ marginTop: '8px', marginBottom: '8px', padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)', backgroundColor: 'var(--rn-clr-background-secondary)' }}>
          <div style={{ fontWeight: 600, fontSize: '12px', marginBottom: '4px' }}>CardPriority Tag Audit (KB-wide)</div>
          <div style={{ fontSize: '11px', lineHeight: 1.6 }}>
            <div><code>taggedRem()</code>: <strong>{tagAudit.taggedRemCount}</strong> rems</div>
            <div>card-bearing rems: <strong>{tagAudit.cardRemCount}</strong></div>
            <div>direct <code>hasPowerup</code>=true: <strong>{tagAudit.hasPowerupCount}</strong> (of which in taggedRem: {tagAudit.inTaggedRemCount})</div>
            <div>hasPowerup=true but <em>missing</em> from taggedRem: <strong style={{ color: tagAudit.powerupNotInTaggedRem > 0 ? '#ef4444' : 'inherit' }}>{tagAudit.powerupNotInTaggedRem}</strong></div>
            <div>priority slot present but <em>no</em> powerup tag: <strong style={{ color: tagAudit.slotButNoPowerup > 0 ? '#ef4444' : 'inherit' }}>{tagAudit.slotButNoPowerup}</strong></div>
          </div>
          <div style={{ marginTop: '6px', fontSize: '11px' }}>
            <div>distinct cardPriority definition rems: <strong style={{ color: tagAudit.distinctDefs.length > 1 ? '#ef4444' : 'inherit' }}>{tagAudit.distinctDefs.length}</strong></div>
            {tagAudit.distinctDefs.map((d) => (
              <div key={d.defId} style={{ paddingLeft: '10px', color: 'var(--rn-clr-content-secondary)' }}>
                • <code>{d.defId}</code> {d.isCanonical ? '(canonical)' : '(DUPLICATE)'} — {d.count} rems
              </div>
            ))}
            {tagAudit.unknownDefCount > 0 && (
              <div style={{ paddingLeft: '10px', color: 'var(--rn-clr-content-secondary)' }}>• unresolved def on {tagAudit.unknownDefCount} rem(s)</div>
            )}
          </div>
          <div style={{ marginTop: '6px', fontSize: '11px', fontWeight: 600 }}>{tagAudit.verdict}</div>
          <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--rn-clr-content-tertiary)' }}>Full breakdown + sample rems in the developer console.</div>
        </div>
      )}

      {/* ── Raw slot diagnostics — KEEP LAST (see the section-order note above) ──
          These are whole-KB / migration-forensics tools, not properties of the
          focused Rem, which is why they live at the bottom rather than beside the
          per-Rem powerup readouts. */}
      <div style={{ marginTop: '16px' }}>
        <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          Raw Slot Diagnostics
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={handleDumpRawSlots}
              style={smallBtnStyle}
              title="Read the RAW stored value of every powerup property on this Rem and its descendants, bypassing getPowerupProperty, and flag values that are stored but unreadable (read-only)"
            >
              Dump Raw Slots (this Rem)
            </button>
            <button
              onClick={handleScanKb}
              disabled={isScanningKb}
              style={{ ...smallBtnStyle, cursor: isScanningKb ? 'wait' : 'pointer', fontWeight: 600 }}
              title="Walk EVERY Rem carrying Incremental or CardPriority and count how many have a detached priority slot or a dangling Next Rep Date reference (read-only, slow)"
            >
              {isScanningKb ? 'Scanning…' : 'Scan Whole KB'}
            </button>
          </div>
        </h2>

        {scanProgress && (
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>
            {scanProgress}
          </div>
        )}

        {/* ── CardPriority repair ──────────────────────────────────────────────
            Ordered dry-run → small live run → full run → staged deletion. The
            deletion is last and separate on purpose: it is the only destructive
            action here. */}
        <div style={{ marginBottom: '12px', padding: '8px', borderRadius: '4px', border: '1px solid var(--rn-clr-border)' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '2px' }}>CardPriority Repair</div>
          <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginBottom: '8px' }}>
            Restores priorities stranded on detached properties. CardPriority is repaired first
            because it has no history fallback — those values are wrong in the app right now.
            Repairing leaves the old property behind; clean it up only after the deletion test.
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button onClick={() => runCardPriorityRepair(true)} disabled={isRepairingCP} style={{ ...smallBtnStyle, cursor: isRepairingCP ? 'wait' : 'pointer' }}>
              1. Dry run
            </button>
            <button onClick={() => handleRepairLive(25)} disabled={isRepairingCP || !repairReport} style={{ ...smallBtnStyle, cursor: isRepairingCP ? 'wait' : 'pointer' }}>
              2. Repair 25 (live)
            </button>
            <button onClick={() => handleRepairLive()} disabled={isRepairingCP || !repairReport} style={{ ...smallBtnStyle, cursor: isRepairingCP ? 'wait' : 'pointer', fontWeight: 600 }}>
              3. Repair all (live)
            </button>
            <button
              onClick={handleBulkOrphanDeletion}
              disabled={isRepairingCP}
              style={{ ...smallBtnStyle, cursor: isRepairingCP ? 'wait' : 'pointer', borderColor: '#ef4444', color: '#ef4444', fontWeight: 600 }}
              title="Delete ALL recorded orphan property Rems. Each is individually guarded and the run aborts on the first DANGER. Only after the 3-Rem test passes."
            >
              5. Delete all orphans
            </button>
            <button
              onClick={handleTestOrphanDeletion}
              // Only disabled while busy. Every other precondition is checked in
              // the handler, which toasts the reason — a disabled button that
              // silently does nothing is indistinguishable from a broken one, and
              // this one disabled itself precisely when it became useful: after a
              // successful repair, `orphanPropertyRemIds` is empty because there
              // was nothing left to repair.
              disabled={isRepairingCP}
              style={{ ...smallBtnStyle, cursor: isRepairingCP ? 'wait' : 'pointer', borderColor: '#ef4444', color: '#ef4444' }}
              title="Deletes 3 orphaned property Rems and reports whether the repaired priority survived. Destructive — run only after a live repair."
            >
              4. Test orphan deletion (3)
            </button>
          </div>

          {repairProgress && (
            <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginTop: '6px' }}>{repairProgress}</div>
          )}

          {repairReport && (
            <div style={{ fontSize: '11px', marginTop: '8px', lineHeight: 1.7 }}>
              <div style={{ fontWeight: 600, color: repairReport.dryRun ? 'var(--rn-clr-content-secondary)' : '#22c55e' }}>
                {repairReport.dryRun ? 'DRY RUN — nothing written' : 'LIVE RUN'}
              </div>
              <div>scanned: <strong>{repairReport.scanned}</strong> · repairable: <strong>{repairReport.candidates}</strong> · skipped as derivable: {repairReport.skippedDerivable}</div>
              {!repairReport.dryRun && (
                <div>
                  repaired: <strong style={{ color: '#22c55e' }}>{repairReport.repaired}</strong>
                  {repairReport.failedVerification > 0 && (
                    <> · <strong style={{ color: '#ef4444' }}>failed verification: {repairReport.failedVerification}</strong></>
                  )}
                  {repairReport.errors.length > 0 && <> · errors: {repairReport.errors.length}</>}
                </div>
              )}
              <div style={{ color: 'var(--rn-clr-content-tertiary)' }}>
                orphan property Rems recorded: {repairReport.orphanPropertyRemIds.length}
              </div>
              {repairReport.notes.map((n, i) => (
                <div key={i} style={{ color: 'var(--rn-clr-content-secondary)' }}>ⓘ {n}</div>
              ))}
            </div>
          )}

          {deletionProbes && (
            <div style={{ marginTop: '8px', fontSize: '11px' }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>Deletion test</div>
              {deletionProbes.map((p) => (
                <div
                  key={p.orphanPropertyRemId}
                  style={{ marginBottom: '4px', color: p.verdict.startsWith('DANGER') ? '#ef4444' : 'var(--rn-clr-content-secondary)' }}
                >
                  <code>{p.orphanPropertyRemId}</code> — held {p.storedValue ?? '?'} · stored {p.apiValueBefore ?? '(empty)'} → {p.apiValueAfter ?? '(empty)'} · resolved {p.resolvedBefore ?? '(none)'} → {p.resolvedAfter ?? '(none)'} · children {p.ownerChildCountBefore ?? '?'} → {p.ownerChildCountAfter ?? '?'}
                  <div>{p.verdict}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {kbScan && (
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--rn-clr-content-tertiary)', marginBottom: '6px' }}>
              Scanned in {(kbScan.durationMs / 1000).toFixed(1)}s
            </div>
            <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse', marginBottom: '10px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--rn-clr-content-tertiary)' }}>
                  <th style={{ padding: '2px 4px' }}>Powerup</th>
                  <th style={{ padding: '2px 4px' }}>Total</th>
                  <th style={{ padding: '2px 4px' }}>OK</th>
                  <th style={{ padding: '2px 4px' }}>Detached</th>
                  <th style={{ padding: '2px 4px' }}>No value</th>
                  <th style={{ padding: '2px 4px' }}>Affected</th>
                </tr>
              </thead>
              <tbody>
                {[kbScan.incremental, kbScan.cardPriority].map((r) => (
                  <tr key={r.code}>
                    <td style={{ padding: '2px 4px', fontWeight: 600 }}>{r.label}</td>
                    <td style={{ padding: '2px 4px' }}>{r.total}</td>
                    <td style={{ padding: '2px 4px' }}>{r.ok}</td>
                    <td style={{ padding: '2px 4px', color: r.detached > 0 ? '#ef4444' : undefined, fontWeight: r.detached > 0 ? 600 : undefined }}>{r.detached}</td>
                    <td style={{ padding: '2px 4px' }}>{r.missing}</td>
                    <td style={{ padding: '2px 4px', color: r.detachedPct > 0 ? '#ef4444' : undefined, fontWeight: 600 }}>{r.detachedPct}%</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ padding: '2px 4px', fontWeight: 600 }}>Next Rep Date</td>
                  <td style={{ padding: '2px 4px' }}>{kbScan.nextRepDate.totalWithProperty}</td>
                  <td style={{ padding: '2px 4px' }}>{kbScan.nextRepDate.ok}</td>
                  <td style={{ padding: '2px 4px', color: kbScan.nextRepDate.dangling > 0 ? '#ef4444' : undefined, fontWeight: kbScan.nextRepDate.dangling > 0 ? 600 : undefined }}>
                    {kbScan.nextRepDate.dangling} dangling
                  </td>
                  <td style={{ padding: '2px 4px' }}>{kbScan.nextRepDate.empty}</td>
                  <td style={{ padding: '2px 4px', color: kbScan.nextRepDate.danglingPct > 0 ? '#ef4444' : undefined, fontWeight: 600 }}>{kbScan.nextRepDate.danglingPct}%</td>
                </tr>
                {kbScan.nextRepDate.dangling > 0 && (
                  <tr>
                    <td style={{ padding: '2px 4px', paddingLeft: '12px', color: 'var(--rn-clr-content-secondary)' }} colSpan={6}>
                      of those dangling: <strong style={{ color: '#22c55e' }}>{kbScan.nextRepDate.danglingRecoverable}</strong> repairable from history
                      ({kbScan.nextRepDate.recoverablePct}%)
                      {kbScan.nextRepDate.danglingUnrecoverable > 0 && (
                        <> · <strong style={{ color: '#ef4444' }}>{kbScan.nextRepDate.danglingUnrecoverable} unrecoverable</strong></>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* The hypothesis test: if dangling refs cluster in the long-interval
                buckets, future-dated daily documents did not survive migration. */}
            {kbScan.nextRepDate.byInterval.length > 0 && (
              <>
                <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>
                  Dangling dates by scheduling interval
                </div>
                <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse', marginBottom: '10px' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--rn-clr-content-tertiary)' }}>
                      <th style={{ padding: '2px 4px' }}>Interval</th>
                      <th style={{ padding: '2px 4px' }}>Resolves</th>
                      <th style={{ padding: '2px 4px' }}>Dangling</th>
                      <th style={{ padding: '2px 4px' }}>Repairable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kbScan.nextRepDate.byInterval.map((row) => (
                      <tr key={row.bucket}>
                        <td style={{ padding: '2px 4px' }}>{row.bucket}</td>
                        <td style={{ padding: '2px 4px' }}>{row.ok}</td>
                        <td style={{ padding: '2px 4px', color: row.dangling > 0 ? '#ef4444' : undefined }}>{row.dangling}</td>
                        <td style={{ padding: '2px 4px', color: '#22c55e' }}>{row.recoverable}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {/* Litter, measured independently of readability — a Rem can read
                correctly and still carry a leftover "Unnamed — N" row. */}
            <div style={{ fontSize: '11px', marginBottom: '6px' }}>
              Leftover priority properties:{' '}
              <strong style={{ color: kbScan.leftoverCount > 0 ? '#f59e0b' : '#22c55e' }}>
                {kbScan.leftoverCount}
              </strong>
              {kbScan.leftoverCount > 0 && (
                <>
                  {' '}(<span style={{ color: '#22c55e' }}>{kbScan.leftoverSafeToDelete} safe to delete</span>
                  {kbScan.leftoverStranded > 0 && (
                    <>, <strong style={{ color: '#ef4444' }}>{kbScan.leftoverStranded} stranded</strong></>
                  )})
                  {kbScan.leftoverStranded > 0 && (
                    <div style={{ marginTop: '2px' }}>
                      Of the stranded:{' '}
                      <strong style={{ color: '#ef4444' }}>{kbScan.strandedNeedsRecovery} need recovery</strong>{' '}
                      (manual/incremental) ·{' '}
                      <strong style={{ color: '#22c55e' }}>{kbScan.strandedDiscardable} derivable</strong>, safe to delete
                      <div style={{ color: 'var(--rn-clr-content-secondary)' }}>
                        {kbScan.strandedBySource.map((s) => `${s.source}: ${s.count} (${s.action})`).join(' · ')}
                      </div>
                    </div>
                  )}
                  <div style={{ color: 'var(--rn-clr-content-secondary)', marginTop: '2px' }}>
                    Excluded as other powerups' own properties:{' '}
                    {kbScan.leftoverSlots.filter((s) => s.category === 'foreign').map((s) => `${s.name} ×${s.count}`).join(', ') || 'none'}
                  </div>
                </>
              )}
            </div>

            {kbScan.notes.map((n, i) => (
              <div key={i} style={{ fontSize: '11px', color: 'var(--rn-clr-content-secondary)', marginTop: '4px' }}>
                ⓘ {n}
              </div>
            ))}
          </div>
        )}

        {/* Result of either tool, kept on screen so it can be selected and copied
            by hand where the clipboard API and file download are both blocked. */}
        {rawSlotDumpText && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <div className="font-semibold text-xs text-[var(--rn-clr-content-tertiary)] uppercase tracking-wider">JSON</div>
              <button onClick={() => setRawSlotDumpText(null)} style={smallBtnStyle}>Clear</button>
            </div>
            <textarea
              readOnly
              value={rawSlotDumpText}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                width: '100%',
                height: '220px',
                fontSize: '10px',
                fontFamily: 'monospace',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid var(--rn-clr-border)',
                backgroundColor: 'var(--rn-clr-background-secondary)',
                color: 'var(--rn-clr-content-primary)',
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

renderWidget(Debug);
