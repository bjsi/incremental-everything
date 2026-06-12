import { useState } from 'react';
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
import { getCardPriority } from '../lib/card_priority';
import { findNonFlashcardDescendantsWithCardPriority, getSpuriousCardPriorityTags, removeCardPriorityFromSpecificRems, removeCardPriorityFromRem, dumpRemPriorityStructure, findRogueCardPriorityRemsInSubtree } from '../lib/card_priority/batch';
import { getDismissedHistoryFromRem } from '../lib/dismissed';
import {
  safeRemTextToString,
  getAllPDFsInRem,
  getPageHistory,
  getPageHistoryKey,
  getReadingStatistics,
} from '../lib/pdfUtils';
import { formatDuration } from '../lib/utils';
import { powerupCode, dismissedPowerupCode, dismissedHistorySlotCode, dismissedDateSlotCode } from '../lib/consts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
dayjs.extend(relativeTime);

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

function Debug() {
  const plugin = usePlugin();
  const ctx = useRunAsync(
    async () => await plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    []
  );
  const remId = ctx?.contextData?.remId;
  const [refreshKey, setRefreshKey] = useState(0);
  
  const debugData = useTrackerPlugin(
    async (rp) => {
      const rem = await rp.rem.findOne(remId);
      if (!rem) return null;

      const incrementalRem = await getIncrementalRemFromRem(rp, rem);
      const cardPriority = await getCardPriority(rp, rem);
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

      return {
        incrementalRem,
        cardPriority,
        dismissed,
        isCardDisabledLocally,
        isCardDisabledInAncestors,
        hasSpuriousTags,
        guaranteedRogue,
        suspicious,
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

  if (!debugData) return null;

  const { incrementalRem, cardPriority, dismissed, isCardDisabledLocally, isCardDisabledInAncestors, hasSpuriousTags, guaranteedRogue, suspicious, rem } = debugData;

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
      const isPowerupProp = await child.isPowerupProperty();
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

      const POWERUP_LABELS: [string, string][] = [
        ['PDFHighlight', BuiltInPowerupCodes.PDFHighlight],
        ['PDFPageNumber', BuiltInPowerupCodes.PDFPageNumber],
        ['Highlight', BuiltInPowerupCodes.Highlight],
        ['HTMLHighlight', BuiltInPowerupCodes.HTMLHighlight],
        ['WebHighlight', BuiltInPowerupCodes.WebHighlight],
        ['UploadedFile', BuiltInPowerupCodes.UploadedFile],
        ['Document', BuiltInPowerupCodes.Document],
        ['Deck', BuiltInPowerupCodes.Deck],
        ['Header', BuiltInPowerupCodes.Header],
        ['Link', BuiltInPowerupCodes.Link],
        ['Sources', BuiltInPowerupCodes.Sources],
        ['ImportedDocument', BuiltInPowerupCodes.ImportedDocument],
        ['DisableCards', BuiltInPowerupCodes.DisableCards],
        ['UsedAsTag', BuiltInPowerupCodes.UsedAsTag],
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
          if (await currentRem.hasPowerup(code)) activePowerups.push(label);
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
      // canonicalContainer  = "Highlights" with "PDF Highlight Section" tag (RemNote-managed, correct)
      // brokenContainers    = "Highlights"-named containers that lack the Section tag (our earlier repairs)
      // orphanedPages       = PDFPageNumber rems sitting directly under the PDF root
      let canonicalContainer: any = null;
      const brokenContainers: any[] = [];
      const orphanedPages: any[] = [];

      for (const child of children) {
        if (await child.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) {
          orphanedPages.push(child);
          continue;
        }
        const childName = await safeRemTextToString(plugin, child.text);
        if (childName !== 'Highlights') continue;
        const tags: any[] = await child.getTagRems();
        const tagNames: string[] = await Promise.all(tags.map((t: any) => safeRemTextToString(plugin, t.text)));
        if (tagNames.includes('PDF Highlight Section')) {
          canonicalContainer = child;
        } else if (await child.hasPowerup(BuiltInPowerupCodes.AutoSort)) {
          brokenContainers.push(child);
        }
      }

      // Collect pages sitting inside broken containers
      const misplacedPages: any[] = [];
      for (const bc of brokenContainers) {
        const bcChildren: any[] = await bc.getChildrenRem();
        for (const c of bcChildren) {
          if (await c.hasPowerup(BuiltInPowerupCodes.PDFPageNumber)) misplacedPages.push(c);
        }
      }

      const allPagesToMove = [...orphanedPages, ...misplacedPages];

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
        fixes.push(`• Move ${allPagesToMove.length} page node(s) into the canonical "Highlights" container`);
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

      // --- Execute: move pages to canonical container ---
      for (const page of allPagesToMove) {
        await page.setParent(canonicalContainer._id);
        console.log(`[RepairPDF] Moved page "${await safeRemTextToString(plugin, page.text)}" → canonical container`);
      }

      // Add Document powerup to PDF root if missing
      if (needsDocumentPowerup) {
        await pdfRem.addPowerup(BuiltInPowerupCodes.Document);
      }

      // Best-effort: remove stray AutoSort from PDF root
      try { await pdfRem.removePowerup(BuiltInPowerupCodes.AutoSort); } catch { /* not critical */ }

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
      if (allPagesToMove.length > 0) parts.push(`moved ${allPagesToMove.length} page(s) to canonical container`);
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
        const storageKey = getPageHistoryKey(remId, pdfRem._id);
        const raw = await plugin.storage.getSynced(storageKey);
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
        console.log(`Raw storage value:`, raw);
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

      await focusedRem.setPowerupProperty(dismissedPowerupCode, dismissedHistorySlotCode, []);
      await focusedRem.setPowerupProperty(dismissedPowerupCode, dismissedDateSlotCode, []);
      await focusedRem.removePowerup(dismissedPowerupCode);

      await plugin.app.toast('Cleaned dismissed powerup and its slots!');
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
    const storageKey = getPageHistoryKey(rId, pdfRem._id);
    const rawStored = await plugin.storage.getSynced(storageKey);
    if (rawStored == null) return null; // no key present
    const history = await getPageHistory(plugin, rId, pdfRem._id);

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
        await plugin.storage.setSynced(p.storageKey, p.patched);
        console.log(`[InflationCleanup] Rewrote ${p.storageKey} — stripped ${p.stripCount} entr(ies).`);
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
          await plugin.storage.setSynced(p.storageKey, p.patched);
          rewritten++;
          console.log(`[GlobalInflationCleanup] Rewrote ${p.storageKey} — stripped ${p.stripCount} entr(ies).`);
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
      </h2>
      <Info className="rem-id" label="Rem ID" data={<code>{remId}</code>} />
      <div className="flex gap-4">
        <Info className="card-disabled" label="Cards Disabled (Locally)" data={isCardDisabledLocally ? <span style={{color: '#ef4444', fontWeight: 600}}>YES</span> : 'No'} />
        <Info className="card-disabled-ancestor" label="Cards Disabled (Inherited)" data={isCardDisabledInAncestors ? <span style={{color: '#ef4444', fontWeight: 600}}>YES</span> : 'No'} />
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

      {incrementalRem && (
        <div style={{ marginTop: '16px' }}>
          <h2 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '12px', paddingBottom: '4px', borderBottom: '1px solid var(--rn-clr-background-tertiary)' }}>Incremental Powerup</h2>
          <Info className="next-rep-date" label="Next Rep (Raw)" data={incrementalRem.nextRepDate} />
          <Info
            className="human-date"
            label="Next Rep (Human)"
            data={`${dayjs(incrementalRem.nextRepDate).format('MMMM D, YYYY')} (${dayjs(incrementalRem.nextRepDate).fromNow()})`}
          />
          <Info className="priority" label="Priority" data={incrementalRem.priority} />
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
          <Info
            className="history"
            label="History"
            data={<pre style={preStyle}>{incrementalRem?.history ? JSON.stringify(incrementalRem.history, null, 2) : '[]'}</pre>}
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
             </div>
           </h2>
           {hasSpuriousTags && (
             <div style={{ marginBottom: '12px', padding: '8px', backgroundColor: 'var(--rn-clr-background-warning)', color: 'var(--rn-clr-content-warning)', borderRadius: '4px', fontSize: '12px', border: '1px solid var(--rn-clr-border-warning)' }}>
               ⚠️ <strong>Spurious Tags Detected:</strong> Rogue CardPriority tags were found on non-flashcard children. Please click "Sanitize Rogue Tags" to cure this rem.
             </div>
           )}
           <div className="flex gap-4 mb-2">
             <Info className="cp-priority" label="Priority" data={cardPriority.priority} />
             <Info className="cp-source" label="Source" data={<span style={{ textTransform: 'capitalize' }}>{cardPriority.source}</span>} />
           </div>
           <div className="flex gap-4 mb-2">
             <Info className="cp-duecards" label="Due Cards" data={cardPriority.dueCards} />
             <Info className="cp-cardcount" label="Total Cards" data={cardPriority.cardCount} />
           </div>
           <Info className="cp-updated" label="Last Updated" data={`${dayjs(cardPriority.lastUpdated).format('MMMM D, YYYY, h:mm a')} (${dayjs(cardPriority.lastUpdated).fromNow()})`} />
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
    </div>
  );
}

renderWidget(Debug);
