import { ReactRNPlugin, RemId, Rem, BuiltInPowerupCodes, RichTextElementRemInterface } from '@remnote/plugin-sdk';
import { allIncrementalRemKey } from './consts';

/**
 * Collects PDF source IDs from a list of rems.
 * Returns both all source IDs and a filtered set of PDF-only source IDs.
 */
export async function collectPdfSourcesFromRems(
  rems: Rem[]
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
  plugin: ReactRNPlugin,
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
  plugin: ReactRNPlugin,
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
  plugin: ReactRNPlugin,
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

