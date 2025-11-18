import { ReactRNPlugin, RemId, Rem, BuiltInPowerupCodes, RichTextElementRemInterface } from '@remnote/plugin-sdk';
import { allIncrementalRemKey } from './consts';

/**
 * Collects PDF source IDs from a list of rems (scopeRem and its descendants).
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
 * Finds all PDF extract IDs that belong to the given PDF sources.
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
 * Builds a quick scope for on-the-fly calculations in GetNextCard callback.
 * Includes descendants and PDF extracts from PDF sources.
 *
 * This is a simplified version that doesn't include all the comprehensive
 * scope features (allRemInDocumentOrPortal, folderQueueRems, etc.) for performance.
 */
export async function buildQuickScope(
  plugin: ReactRNPlugin,
  scopeRemId: RemId
): Promise<Set<RemId>> {
  const scopeRem = await plugin.rem.findOne(scopeRemId);
  if (!scopeRem) return new Set();

  const descendants = await scopeRem.getDescendants();

  // Collect PDF sources from scope rem AND all its descendants
  const { allSourceIds, pdfSourceIds } = await collectPdfSourcesFromRems([scopeRem, ...descendants]);

  // Find PDF extracts that belong to PDF sources
  const pdfExtractIds = await findPdfExtractIds(plugin, pdfSourceIds);

  return new Set<RemId>([
    scopeRem._id,
    ...descendants.map(r => r._id),
    ...allSourceIds,
    ...pdfExtractIds
  ]);
}
