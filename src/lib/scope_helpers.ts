import { RNPlugin, RemId, PluginRem, BuiltInPowerupCodes, RichTextElementRemInterface } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, allCardPriorityInfoKey, powerupCode, nextRepDateSlotCode } from './consts';
import type { CardPriorityInfo } from './card_priority/types';

/**
 * Collects PDF source IDs from a list of rems.
 * Returns both all source IDs and a filtered set of PDF-only source IDs.
 */
export async function collectPdfSourcesFromRems(
  rems: PluginRem[]
): Promise<{ allSourceIds: string[]; pdfSourceIds: Set<string> }> {
  const pdfSourceIds = new Set<string>();
  const allSourceIds: string[] = [];

  for (const rem of rems) {
    try {
      const sources = await rem.getSources();
      for (const source of sources) {
        allSourceIds.push(source._id);
        if (await source.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
          pdfSourceIds.add(source._id);
        }
      }
    } catch (error) {
      // Skip if getSources fails for this rem
    }
  }

  return { allSourceIds, pdfSourceIds };
}

/**
 * Finds all PDF extract IDs (highlights) that belong to the given PDF sources.
 * Returns an array of RemIds for PDF extracts that are incremental rems.
 */
export async function findPdfExtractIds(
  plugin: RNPlugin,
  pdfSourceIds: Set<string>
): Promise<RemId[]> {
  if (pdfSourceIds.size === 0) {
    return [];
  }

  const pdfExtractIds: RemId[] = [];
  const allIncRems = (await plugin.storage.getSession<any[]>(allIncrementalRemKey)) || [];

  for (const incRem of allIncRems) {
    try {
      const rem = await plugin.rem.findOne(incRem.remId);
      if (rem && await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight)) {
        const pdfId = (
          (
            await rem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.PDFHighlight>(
              BuiltInPowerupCodes.PDFHighlight,
              'PdfId'
            )
          )[0] as RichTextElementRemInterface
        )?._id;

        if (pdfId && pdfSourceIds.has(pdfId)) {
          pdfExtractIds.push(incRem.remId);
        }
      }
    } catch (error) {
      // Skip if there's an error with this rem
    }
  }

  return pdfExtractIds;
}

/**
 * Gets all descendant IDs from PDF sources.
 * This includes notes/flashcards created inside PDFs.
 */
export async function getPdfDescendantIds(
  plugin: RNPlugin,
  pdfSourceIds: Set<string>
): Promise<RemId[]> {
  if (pdfSourceIds.size === 0) {
    return [];
  }

  const pdfDescendantIds: RemId[] = [];

  for (const pdfId of pdfSourceIds) {
    try {
      const pdfRem = await plugin.rem.findOne(pdfId);
      if (pdfRem) {
        const descendants = await pdfRem.getDescendants();
        for (const desc of descendants) {
          pdfDescendantIds.push(desc._id);
        }
      }
    } catch (error) {
      // Skip if there's an error with this PDF
    }
  }

  return pdfDescendantIds;
}

/**
 * Builds a document scope containing all related rem IDs.
 *
 * This is the SINGLE SOURCE OF TRUTH for building document scopes.
 * Use this function in:
 * - inc_rem_counter.tsx (to count incRems in a document)
 * - inc_rem_list.tsx (to list incRems in a document)
 * - callbacks.ts (for on-the-fly scope calculation in GetNextCard)
 *
 * The scope includes:
 * - The document itself
 * - All descendants of the document
 * - All sources referenced by the document and its descendants
 * - All PDF highlights from PDFs that are sources
 * - All descendants of PDFs that are sources (notes/flashcards inside PDFs)
 *
 * @param plugin Plugin instance to access the RemNote API
 * @param documentId RemId of the document to build the scope for
 * @returns Set of RemIds that belong to this document's scope
 */
export async function buildDocumentScope(
  plugin: RNPlugin,
  documentId: RemId
): Promise<Set<RemId>> {
  const document = await plugin.rem.findOne(documentId);
  if (!document) return new Set();

  const descendants = await document.getDescendants();
  const descendantIds = new Set<RemId>([documentId, ...descendants.map(d => d._id)]);

  // Collect PDF sources from document and all its descendants
  const { allSourceIds, pdfSourceIds } = await collectPdfSourcesFromRems([document, ...descendants]);

  // Find PDF extracts (highlights) that belong to PDF sources
  const pdfExtractIds = await findPdfExtractIds(plugin, pdfSourceIds);

  // Find descendants of PDF sources (notes/flashcards inside PDFs)
  const pdfDescendantIds = await getPdfDescendantIds(plugin, pdfSourceIds);

  // Add all to the scope
  allSourceIds.forEach(id => descendantIds.add(id));
  pdfExtractIds.forEach(id => descendantIds.add(id));
  pdfDescendantIds.forEach(id => descendantIds.add(id));

  return descendantIds;
}

/** How many document roots we expand concurrently while draining the worklist. */
const SCOPE_EXPANSION_CONCURRENCY = 12;

/**
 * When true, the top-level build logs a per-mechanism card attribution breakdown
 * (which gathering rule contributes the marginal rems/cards). Temporary instrument
 * to decide how to tighten over-collection; flip off (or remove) once settled.
 */
const SCOPE_DIAGNOSTICS = false;

/**
 * Builds a comprehensive scope for a given rem, mirroring RemNote's own
 * document-flashcard gathering rules
 * (https://help.remnote.com/en/articles/8892109).
 *
 * RECURSIVE expansion (treated like nested documents — gathered via a worklist):
 * - The rem itself, its descendants, and its document/portal context
 * - All sources (Upload > Link / /Link Source), incl. linked PDFs whose highlights
 *   and in-PDF notes are then picked up as descendants of the recursed PDF rem
 * - All tagged instances (rems tagged by the document or its descendants)
 *
 * LEAF inclusion (the specific rem only — NOT recursive, per RemNote's rule that
 * "referenced card gathering is not recursive"):
 * - Rems referenced within the document (remsBeingReferenced)
 * - Rems referencing the document or its descendants (remsReferencingThis / backrefs)
 *
 * The relationship calls are fanned ONLY over the document body (rem + descendants
 * + portal/table context) — never over `allRemInFolderQueue()`, which is RemNote's
 * own (potentially enormous) queue concept and is not part of these gathering rules.
 * The folder queue is included once, for the top-level rem, as plain scope members.
 *
 * Each rem is expanded as a root at most once and fanned out at most once, so the
 * total work is O(unique rems) regardless of how the source/tag graph overlaps.
 *
 * @param plugin Plugin instance
 * @param scopeRemId RemId to build scope for
 */
export async function buildComprehensiveScope(
  plugin: RNPlugin,
  scopeRemId: RemId
): Promise<Set<RemId>> {
  const result = new Set<RemId>();
  const expandedRoots = new Set<RemId>(); // roots already gathered (dedupe + loop guard)
  const fannedRems = new Set<RemId>();     // body rems already fanned out

  // Per-mechanism membership, for the diagnostic card-attribution breakdown.
  const fqSet = new Set<RemId>();          // allRemInFolderQueue (base truth)
  const topBodySet = new Set<RemId>();     // top rem + its descendants + its context
  const expansionBodySet = new Set<RemId>(); // bodies of recursed sources/tagged roots
  const referencedSet = new Set<RemId>();  // remsBeingReferenced leaves (any root)
  const backrefSet = new Set<RemId>();     // remsReferencingThis leaves (any root)
  // Leaves gathered specifically from the TOP document body — i.e. the ones option
  // (B) would KEEP. The rest of referencedSet/backrefSet come from source/tagged
  // expansion bodies and are what (B) would DROP.
  const refFromTopSet = new Set<RemId>();
  const backrefFromTopSet = new Set<RemId>();

  const slot = await plugin.powerup.getPowerupSlotByCode(powerupCode, nextRepDateSlotCode);
  const nextRepDateSlotId: RemId | null = slot?._id ?? null;

  const topRem = await plugin.rem.findOne(scopeRemId);
  if (!topRem) return result;

  // The folder queue can be enormous and is not part of RemNote's document
  // gathering rules, so include it once (for the top-level rem) as plain members
  // and never fan relationship calls over it.
  const folderQueueRems = await topRem.allRemInFolderQueue();
  for (const r of folderQueueRems) {
    result.add(r._id);
    fqSet.add(r._id);
  }

  let topDescendantCount = 0;
  let topContextCount = 0;

  // Expand one document root: gather its body, emit reference leaves, and return
  // the newly discovered roots (sources + tagged instances) to expand next.
  const expandRoot = async (rootId: RemId): Promise<RemId[]> => {
    const rootRem = await plugin.rem.findOne(rootId);
    if (!rootRem) return [];

    const [descendants, context] = await Promise.all([
      rootRem.getDescendants(),
      rootRem.allRemInDocumentOrPortal(),
    ]);

    const isTopRoot = rootId === scopeRemId;
    if (isTopRoot) {
      topDescendantCount = descendants.length;
      topContextCount = context.length;
    }

    const bodyBucket = isTopRoot ? topBodySet : expansionBodySet;
    result.add(rootRem._id);
    bodyBucket.add(rootRem._id);
    for (const r of descendants) {
      result.add(r._id);
      bodyBucket.add(r._id);
    }
    for (const r of context) {
      result.add(r._id);
      bodyBucket.add(r._id);
    }

    // Document body for relationship gathering — NOT the folder queue. Fan each
    // rem out at most once across the entire traversal.
    const seen = new Set<RemId>();
    const body = [rootRem, ...descendants, ...context].filter(r => {
      if (seen.has(r._id) || fannedRems.has(r._id)) return false;
      seen.add(r._id);
      return true;
    });

    const discovered = new Set<RemId>();
    await Promise.all(
      body.map(async rem => {
        fannedRems.add(rem._id);
        const [sources, tagged, referenced, referencing] = await Promise.all([
          rem.getSources().catch(() => []),
          rem.taggedRem().catch(() => []),
          rem.remsBeingReferenced().catch(() => []),
          rem.remsReferencingThis().catch(() => []),
        ]);

        for (const s of sources) discovered.add(s._id);
        for (const t of tagged) discovered.add(t._id);
        // Leaves: referenced + backreferenced rems contribute only their own id.
        for (const r of referenced) {
          result.add(r._id);
          referencedSet.add(r._id);
          if (isTopRoot) refFromTopSet.add(r._id);
        }
        for (const ref of referencing) {
          if (nextRepDateSlotId && (ref.text?.[0] as any)?._id === nextRepDateSlotId) {
            if (ref.parent) {
              result.add(ref.parent);
              backrefSet.add(ref.parent);
              if (isTopRoot) backrefFromTopSet.add(ref.parent);
            }
          } else {
            result.add(ref._id);
            backrefSet.add(ref._id);
            if (isTopRoot) backrefFromTopSet.add(ref._id);
          }
        }
      })
    );

    return [...discovered];
  };

  // Bounded-concurrency drain of the root worklist.
  const queue: RemId[] = [scopeRemId];
  expandedRoots.add(scopeRemId);
  const active = new Set<Promise<void>>();

  const launch = (rootId: RemId) => {
    const p = expandRoot(rootId)
      .then(newRoots => {
        for (const id of newRoots) {
          if (!expandedRoots.has(id)) {
            expandedRoots.add(id);
            queue.push(id);
          }
        }
      })
      .catch(() => {}) // a failing root must not abort the whole scope build
      .finally(() => {
        active.delete(p);
      });
    active.add(p);
  };

  while (queue.length > 0 || active.size > 0) {
    while (queue.length > 0 && active.size < SCOPE_EXPANSION_CONCURRENCY) {
      launch(queue.shift()!);
    }
    if (active.size > 0) await Promise.race(active);
  }

  console.log(`[buildComprehensiveScope] ✓ Top-level: ${topDescendantCount} descendants, ${topContextCount} portal/table context rems`);
  console.log(`[buildComprehensiveScope] ✓ Found ${folderQueueRems.length} rems via allRemInFolderQueue (top-level only, not fanned)`);
  console.log(`[buildComprehensiveScope] ✓ Expanded ${expandedRoots.size} document roots (scope + sources + tagged instances)`);
  console.log(`[buildComprehensiveScope] Comprehensive scope contains ${result.size} unique rems`);

  if (SCOPE_DIAGNOSTICS) {
    // Order matters: top-reachable ref/backref buckets are claimed BEFORE the
    // "any root" sets, so the latter end up holding only the expansion-only
    // remainder — exactly what option (B) would drop.
    await logScopeAttribution(plugin, result, [
      { name: 'allRemInFolderQueue (base truth)', ids: fqSet },
      { name: 'top document body (rem + descendants + context)', ids: topBodySet },
      { name: 'source/tagged expansion (their bodies)', ids: expansionBodySet },
      { name: 'referenced — from TOP body          [(B) KEEPS]', ids: refFromTopSet },
      { name: 'backreferenced — from TOP body      [(B) KEEPS]', ids: backrefFromTopSet },
      { name: 'referenced — expansion-only         [(B) DROPS]', ids: referencedSet },
      { name: 'backreferenced — expansion-only     [(B) DROPS]', ids: backrefSet },
    ]);
  }

  return result;
}

/**
 * Diagnostic: attributes the card-bearing rems in `result` to the gathering
 * mechanism that FIRST claimed them, in the given priority order. The marginal
 * card counts for the later buckets (referenced / backreferenced) are exactly the
 * over-collection beyond the folder-queue base + structural expansion. Temporary —
 * see {@link SCOPE_DIAGNOSTICS}.
 */
async function logScopeAttribution(
  plugin: RNPlugin,
  result: Set<RemId>,
  buckets: Array<{ name: string; ids: Set<RemId> }>
): Promise<void> {
  const allCardInfos = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
  const cardMap = new Map<RemId, CardPriorityInfo>();
  for (const info of allCardInfos) cardMap.set(info.remId, info);

  const claimed = new Set<RemId>();
  console.log('[buildComprehensiveScope] ── card attribution (marginal, first-touch in priority order) ──');
  for (const { name, ids } of buckets) {
    let rems = 0, remsWithCards = 0, cards = 0, due = 0;
    for (const id of ids) {
      if (claimed.has(id)) continue;
      claimed.add(id);
      rems++;
      const info = cardMap.get(id);
      if (info && info.cardCount > 0) {
        remsWithCards++;
        cards += info.cardCount;
        due += info.dueCards;
      }
    }
    console.log(
      `[buildComprehensiveScope]   ${name}: +${rems} rems, +${remsWithCards} rems-with-cards, +${cards} cards (${due} due)`
    );
  }

  let totRemsWithCards = 0, totCards = 0, totDue = 0;
  for (const id of result) {
    const info = cardMap.get(id);
    if (info && info.cardCount > 0) {
      totRemsWithCards++;
      totCards += info.cardCount;
      totDue += info.dueCards;
    }
  }
  console.log(
    `[buildComprehensiveScope]   TOTAL: ${totRemsWithCards} rems-with-cards, ${totCards} cards (${totDue} due)`
  );
}