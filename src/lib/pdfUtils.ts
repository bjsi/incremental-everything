// lib/pdfUtils.ts
import { RNPlugin, Rem, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode } from './consts';

/**
 * Generate key for storing current page position per incremental rem
 */
export const getCurrentPageKey = (incrementalRemId: string, pdfRemId: string) => 
  `incremental_current_page_${incrementalRemId}_${pdfRemId}`;

/**
 * Generate key for storing page range per incremental rem  
 */
export const getPageRangeKey = (incrementalRemId: string, pdfRemId: string) => 
  `incremental_page_range_${incrementalRemId}_${pdfRemId}`;

/**
 * Generate key for storing page history per incremental rem
 */
export const getPageHistoryKey = (incrementalRemId: string, pdfRemId: string) => 
  `incremental_page_history_${incrementalRemId}_${pdfRemId}`;

/**
 * Get the current reading position for an incremental rem
 */
export const getIncrementalReadingPosition = async (
  plugin: RNPlugin, 
  incrementalRemId: string, 
  pdfRemId: string
): Promise<number | null> => {
  const pageKey = getCurrentPageKey(incrementalRemId, pdfRemId);
  const savedPage = await plugin.storage.getSynced(pageKey);
  return typeof savedPage === 'number' ? savedPage : null;
};

/**
 * Set the current reading position for an incremental rem
 */
export const setIncrementalReadingPosition = async (
  plugin: RNPlugin, 
  incrementalRemId: string, 
  pdfRemId: string, 
  page: number
): Promise<void> => {
  const pageKey = getCurrentPageKey(incrementalRemId, pdfRemId);
  await plugin.storage.setSynced(pageKey, page);
  
  await addPageToHistory(plugin, incrementalRemId, pdfRemId, page);
};

/**
 * Get the page range for an incremental rem
 */
export const getIncrementalPageRange = async (
  plugin: RNPlugin, 
  incrementalRemId: string, 
  pdfRemId: string
): Promise<{start: number, end: number} | null> => {
  const rangeKey = getPageRangeKey(incrementalRemId, pdfRemId);
  const savedRange = await plugin.storage.getSynced(rangeKey);
  return savedRange && typeof savedRange === 'object' && savedRange.start && savedRange.end 
    ? savedRange as {start: number, end: number} 
    : null;
};

/**
 * Set the page range for an incremental rem
 */
export const setIncrementalPageRange = async (
  plugin: RNPlugin, 
  incrementalRemId: string, 
  pdfRemId: string, 
  start: number, 
  end: number
): Promise<void> => {
  const rangeKey = getPageRangeKey(incrementalRemId, pdfRemId);
  await plugin.storage.setSynced(rangeKey, { start, end });
};

/**
 * Get the reading history for an incremental rem with timestamps
 */
export const getPageHistory = async (
  plugin: RNPlugin,
  incrementalRemId: string,
  pdfRemId: string
): Promise<Array<{page: number, timestamp: number}>> => {
  const historyKey = getPageHistoryKey(incrementalRemId, pdfRemId);
  const history = await plugin.storage.getSynced(historyKey);
  
  // Handle both old format (just numbers) and new format (with timestamps)
  if (Array.isArray(history)) {
    return history.map(entry => {
      if (typeof entry === 'number') {
        // Old format: just page number, no timestamp
        return { page: entry, timestamp: 0 };
      } else if (entry && typeof entry.page === 'number') {
        // New format with timestamp
        return entry;
      } else {
        // Invalid entry
        return null;
      }
    }).filter(Boolean) as Array<{page: number, timestamp: number}>;
  }
  
  return [];
};

/**
 * Add a page to the reading history with timestamp
 */
export const addPageToHistory = async (
  plugin: RNPlugin,
  incrementalRemId: string,
  pdfRemId: string,
  page: number
): Promise<void> => {
  const historyKey = getPageHistoryKey(incrementalRemId, pdfRemId);
  const history = await getPageHistory(plugin, incrementalRemId, pdfRemId);
  
  // Add timestamp with page number
  const entry = {
    page,
    timestamp: Date.now()
  };
  
  history.push(entry);
  
  // Keep only last 100 entries to avoid storage bloat
  const trimmedHistory = history.slice(-100);
  
  await plugin.storage.setSynced(historyKey, trimmedHistory);
};

/**
 * Finds the first PDF Rem within a given Rem or its sources.
 */
export const findPDFinRem = async (plugin: RNPlugin, rem: Rem): Promise<Rem | null> => {
  const remName = await plugin.richText.toString(rem.text || []);
  console.log(`[findPDFinRem] Starting search in Rem: "${remName}" (${rem._id})`);

  const isUploadedPdf = async (r: Rem): Promise<boolean> => {
    const hasPowerup = await r.hasPowerup(BuiltInPowerupCodes.UploadedFile);
    if (!hasPowerup) return false;
    try {
      const url = await r.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
      return typeof url === 'string' && url.toLowerCase().endsWith('.pdf');
    } catch (e) {
      return false;
    }
  };

  if (await isUploadedPdf(rem)) return rem;

  const sources = await rem.getSources();
  for (const source of sources) {
    if (await isUploadedPdf(source)) return source;
  }

  return null;
};

/**
 * Generate key for storing a persistent list of rems known to be associated with a PDF.
 */
const getKnownPdfRemsKey = (pdfRemId: string) => `known_pdf_rems_${pdfRemId}`;

/**
 * Get descendants up to a specified depth
 */
const getDescendantsToDepth = async (rem: Rem, maxDepth: number): Promise<Rem[]> => {
  const result: Rem[] = [];
  
  const collectDescendants = async (currentRem: Rem, currentDepth: number) => {
    if (currentDepth >= maxDepth) return;
    
    const children = await currentRem.getChildrenRem();
    for (const child of children) {
      result.push(child);
      await collectDescendants(child, currentDepth + 1);
    }
  };
  
  await collectDescendants(rem, 0);
  return result;
};

/**
 * Get all rems (incremental and non-incremental) that use a specific PDF
 * This function is called from the page-range popup widget
 */
export const getAllIncrementsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string
): Promise<Array<{
  remId: string;
  name: string;
  range: {start: number, end: number} | null;
  currentPage: number | null;
  isIncremental: boolean;
}>> => {
  try {
    const result: Array<{
      remId: string;
      name: string;
      range: {start: number, end: number} | null;
      currentPage: number | null;
      isIncremental: boolean;
    }> = [];
    
    const processedRemIds = new Set<string>();
    
    // Get the PDF rem
    const pdfRem = await plugin.rem.findOne(pdfRemId);
    if (!pdfRem) return result;
    
    console.log('Searching for rems using PDF:', pdfRemId);
    
    // Get the context - the incremental rem that opened the popup
    const contextData = await plugin.storage.getSession('pageRangeContext');
    const incrementalRemId = contextData?.incrementalRemId;
    
    if (!incrementalRemId) {
      console.log('No context incremental rem found, returning empty results');
      return result;
    }
    
    // Get the incremental rem that has the PDF as source (e.g., Chapter 9)
    const incrementalRem = await plugin.rem.findOne(incrementalRemId);
    if (!incrementalRem) {
      console.log('Incremental rem not found');
      return result;
    }
    
    // Get the parent of this incremental rem (e.g., BTM folder)
    let searchRoot: Rem | null = null;
    if (incrementalRem.parent) {
      searchRoot = await plugin.rem.findOne(incrementalRem.parent);
    }
    
    // If no parent, use the incremental rem itself as the search root
    if (!searchRoot) {
      searchRoot = incrementalRem;
    }
    
    console.log(`Search root: "${await plugin.richText.toString(searchRoot.text || [])}" (${searchRoot._id})`);
    
    // Collect the search root and its descendants (up to 3 levels)
    const remsToCheck: Rem[] = [searchRoot];
    const descendants = await getDescendantsToDepth(searchRoot, 3);
    remsToCheck.push(...descendants);
    
    console.log(`Checking ${remsToCheck.length} rems (parent + descendants)`);
    
    // Check each rem to see if it has the target PDF as a source
    for (const rem of remsToCheck) {
      if (processedRemIds.has(rem._id)) continue;
      processedRemIds.add(rem._id);
      
      // Use findPDFinRem to check if this rem has access to a PDF
      const foundPDF = await findPDFinRem(plugin, rem);
      
      // Only include if the found PDF matches our target PDF
      if (foundPDF && foundPDF._id === pdfRemId) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        const remText = rem.text ? await plugin.richText.toString(rem.text) : 'Untitled';
        
        const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
        const currentPage = isIncremental ? 
          await getIncrementalReadingPosition(plugin, rem._id, pdfRemId) : null;
        
        result.push({
          remId: rem._id,
          name: remText,
          range,
          currentPage,
          isIncremental
        });
        
        console.log(`Found rem with PDF: "${remText}" (Incremental: ${isIncremental})`);
      }
    }
    
    // Also check known rems from storage (for formerly incremental rems)
    const knownRemsKey = getKnownPdfRemsKey(pdfRemId);
    let knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
    
    for (const remId of knownRemIds) {
      if (processedRemIds.has(remId)) continue;
      
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        const remText = rem.text ? await plugin.richText.toString(rem.text) : 'Untitled';
        
        // Verify it still has the PDF as source
        const foundPDF = await findPDFinRem(plugin, rem);
        if (foundPDF && foundPDF._id === pdfRemId) {
          const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
          const currentPage = isIncremental ? 
            await getIncrementalReadingPosition(plugin, rem._id, pdfRemId) : null;
          
          result.push({
            remId: rem._id,
            name: remText,
            range,
            currentPage,
            isIncremental
          });
          processedRemIds.add(rem._id);
          
          console.log(`Found known rem: "${remText}" (Incremental: ${isIncremental})`);
        }
      }
    }
    
    // Update the known rems list for future use
    const allFoundRemIds = Array.from(processedRemIds);
    await plugin.storage.setSynced(knownRemsKey, allFoundRemIds);
    
    // Sort results: incremental rems first, then by name
    result.sort((a, b) => {
      if (a.isIncremental !== b.isIncremental) {
        return a.isIncremental ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    
    console.log(`Total rems found using PDF: ${result.length}`);
    return result;
  } catch (error) {
    console.error('Error getting rems for PDF:', error);
    return [];
  }
};

/**
 * Clear all data for an incremental rem + PDF combination
 */
export const clearIncrementalPDFData = async (
  plugin: RNPlugin,
  incrementalRemId: string,
  pdfRemId: string
): Promise<void> => {
  const pageKey = getCurrentPageKey(incrementalRemId, pdfRemId);
  const rangeKey = getPageRangeKey(incrementalRemId, pdfRemId);
  const historyKey = getPageHistoryKey(incrementalRemId, pdfRemId);
  
  await plugin.storage.setSynced(pageKey, null);
  await plugin.storage.setSynced(rangeKey, null);
  await plugin.storage.setSynced(historyKey, null);
};