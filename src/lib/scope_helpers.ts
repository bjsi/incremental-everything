import { RNPlugin, RemId, PluginRem, BuiltInPowerupCodes, RichTextElementRemInterface } from '@remnote/plugin-sdk';
import { allIncrementalRemKey, powerupCode, nextRepDateSlotCode } from './consts';

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

/**
 * Builds a comprehensive scope for a given rem by gathering all related rems.
 * * This includes:
 * - The rem itself
 * - All descendants
 * - All rems in the same document or portal (CRITICAL for Tables/Portals)
 * - All folder queue rems
 * - All sources
 * - All rems referencing this rem (excluding nextRepDate slot references)
 * - PDF Extracts and their descendants
 * * @param plugin Plugin instance
 * @param scopeRemId RemId to build scope for
 */
export async function buildComprehensiveScope(
  plugin: RNPlugin,
  scopeRemId: RemId
): Promise<Set<RemId>> {
  const scopeRem = await plugin.rem.findOne(scopeRemId);
  if (!scopeRem) return new Set();

  const descendants = await scopeRem.getDescendants();

  // This captures items inside Portals and Tables
  const allRemsInContext = await scopeRem.allRemInDocumentOrPortal();

  const folderQueueRems = await scopeRem.allRemInFolderQueue();
  const sources = await scopeRem.getSources();

  const nextRepDateSlotRem = await plugin.powerup.getPowerupSlotByCode(
    powerupCode,
    nextRepDateSlotCode
  );

  const referencingRems = ((await scopeRem.remsReferencingThis()) || [])
    .map((rem) => {
      // Filter out technical slot references
      if (nextRepDateSlotRem && (rem.text?.[0] as any)?._id === nextRepDateSlotRem._id) {
        return rem.parent;
      }
      return rem._id;
    })
    .filter((id): id is RemId => id !== null && id !== undefined);

  // Collect PDF sources from scopeRem and all descendants
  const { pdfSourceIds } = await collectPdfSourcesFromRems([scopeRem, ...descendants]);

  // Find PDF extracts (highlights) that belong to PDF sources
  const pdfExtractIds = await findPdfExtractIds(plugin, pdfSourceIds);

  // Find descendants of PDF sources (notes/flashcards inside PDFs)
  const pdfDescendantIds = await getPdfDescendantIds(plugin, pdfSourceIds);

  return new Set<RemId>([
    scopeRem._id,
    ...descendants.map(r => r._id),
    ...allRemsInContext.map(r => r._id),
    ...folderQueueRems.map(r => r._id),
    ...sources.map(r => r._id),
    ...referencingRems,
    ...pdfExtractIds,
    ...pdfDescendantIds
  ]);
}