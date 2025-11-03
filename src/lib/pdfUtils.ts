// lib/pdfUtils.ts
import { RNPlugin, Rem, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode, allIncrementalRemKey } from './consts';

/**
 * Safely convert rem text to string, handling all edge cases
 */
export const safeRemTextToString = async (
  plugin: RNPlugin, 
  remText: any
): Promise<string> => {
  // Handle null/undefined
  if (remText == null) {
    return 'Untitled';
  }
  
  // Handle non-array types
  if (!Array.isArray(remText)) {
    console.warn('rem.text is not an array:', typeof remText, remText);
    return 'Untitled';
  }
  
  // Handle empty array
  if (remText.length === 0) {
    return 'Untitled';
  }
  
  // Try to normalize first (this might fix malformed richText)
  try {
    const normalized = await plugin.richText.normalize(remText);
    
    // Then try to convert to string
    try {
      const text = await plugin.richText.toString(normalized);
      // Handle empty string result
      if (!text || text.trim().length === 0) {
        return 'Untitled';
      }
      return text;
    } catch (toStringError) {
      // If toString fails after normalization, try manual extraction
      console.warn('toString failed after normalization, trying manual extraction');
      const manualText = extractTextManually(normalized);
      return manualText || 'Untitled';
    }
  } catch (normalizeError) {
    // If normalize fails, try toString directly on original
    try {
      const text = await plugin.richText.toString(remText);
      if (!text || text.trim().length === 0) {
        return 'Untitled';
      }
      return text;
    } catch (toStringError) {
      // Last resort: manual extraction
      console.warn('All conversion methods failed, using manual extraction. Original text:', remText);
      const manualText = extractTextManually(remText);
      return manualText || 'Untitled';
    }
  }
};

/**
 * Manually extract text from richText array as a fallback
 */
const extractTextManually = (richText: any): string => {
  if (!Array.isArray(richText)) return '';
  
  let text = '';
  for (const element of richText) {
    if (typeof element === 'string') {
      text += element;
    } else if (element && typeof element === 'object') {
      // Handle text elements with formatting
      if (element.i === 'm' && element.text) {
        text += element.text;
      }
      // Handle other text-like elements
      else if (element.text) {
        text += element.text;
      }
    }
  }
  return text.trim();
};

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
  return savedRange && typeof savedRange === 'object' && 'start' in savedRange
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
 * Finds a specific PDF Rem within a given Rem or its sources.
 * If targetPdfId is provided, searches for that specific PDF.
 * If not provided, returns the first PDF found.
 */
export const findPDFinRem = async (
  plugin: RNPlugin, 
  rem: Rem, 
  targetPdfId?: string
): Promise<Rem | null> => {
  const isUploadedPdf = async (r: Rem): Promise<boolean> => {
    const hasPowerup = await r.hasPowerup(BuiltInPowerupCodes.UploadedFile);
    if (!hasPowerup) return false;
    try {
      const url = await r.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
      const isPdf = typeof url === 'string' && url.toLowerCase().endsWith('.pdf');
      return isPdf;
    } catch (e) {
      return false;
    }
  };

  // Check if rem itself is a PDF
  if (await isUploadedPdf(rem)) {
    if (!targetPdfId || rem._id === targetPdfId) {
      console.log(`    [findPDFinRem] Rem itself is a PDF (${rem._id})`);
      return rem;
    }
  }

  // Check sources
  const sources = await rem.getSources();
  console.log(`    [findPDFinRem] Checking ${sources.length} sources`);
  
  const foundPdfs: Rem[] = [];
  
  for (const source of sources) {
    if (await isUploadedPdf(source)) {
      const sourceText = await safeRemTextToString(plugin, source.text);
      console.log(`    [findPDFinRem] Found PDF in source: "${sourceText}" (${source._id})`);
      foundPdfs.push(source);
      
      // If we're looking for a specific PDF and found it, return immediately
      if (targetPdfId && source._id === targetPdfId) {
        console.log(`    [findPDFinRem] ✓ MATCH! This is the target PDF`);
        return source;
      }
    }
  }
  
  // If we have a target PDF but didn't find it, return null
  if (targetPdfId) {
    console.log(`    [findPDFinRem] Found ${foundPdfs.length} PDF(s) but none matched target ${targetPdfId}`);
    return null;
  }
  
  // If no target specified, return the first PDF found (backward compatibility)
  return foundPdfs.length > 0 ? foundPdfs[0] : null;
};

/**
 * Generate key for storing a persistent list of rems known to be associated with a PDF.
 */
const getKnownPdfRemsKey = (pdfRemId: string) => `known_pdf_rems_${pdfRemId}`;

/**
 * Get descendants up to a specified depth
 */
export const getDescendantsToDepth = async (rem: Rem, maxDepth: number): Promise<Rem[]> => {
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
    
    const pdfRem = await plugin.rem.findOne(pdfRemId);
    if (!pdfRem) return result;
    
    console.log('Searching for rems using PDF:', pdfRemId);
    
    const contextData = await plugin.storage.getSession('pageRangeContext');
    const incrementalRemId = contextData?.incrementalRemId;
    
    if (!incrementalRemId) {
      console.log('No context incremental rem found, returning empty results');
      return result;
    }
    
    const incrementalRem = await plugin.rem.findOne(incrementalRemId);
    if (!incrementalRem) {
      console.log('Incremental rem not found');
      return result;
    }
    
    // ===== PART 1: LOCAL SEARCH for NON-incremental rems =====
    console.log('\n===== PART 1: Searching locally for non-incremental rems =====');
    
    const remsToCheck: Rem[] = [];
    const processSearchScope = new Set<string>();
    
    // Get parent and search from there
    let searchRoot: Rem | null = null;
    if (incrementalRem.parent) {
      searchRoot = await plugin.rem.findOne(incrementalRem.parent);
      
      if (searchRoot) {
        // Add parent
        if (!processSearchScope.has(searchRoot._id)) {
          remsToCheck.push(searchRoot);
          processSearchScope.add(searchRoot._id);
        }
        
        // Add all siblings
        const siblings = await searchRoot.getChildrenRem();
        for (const sibling of siblings) {
          if (!processSearchScope.has(sibling._id)) {
            remsToCheck.push(sibling);
            processSearchScope.add(sibling._id);
          }
        }
        
        // Add descendants of parent (up to 3 levels)
        const descendants = await getDescendantsToDepth(searchRoot, 3);
        for (const desc of descendants) {
          if (!processSearchScope.has(desc._id)) {
            remsToCheck.push(desc);
            processSearchScope.add(desc._id);
          }
        }
        
        const searchRootText = await safeRemTextToString(plugin, searchRoot.text);
        console.log(`Search root (parent): "${searchRootText}" (${searchRoot._id})`);
      }
    }
    
    console.log(`Checking ${remsToCheck.length} local rems (parent + siblings + descendants)`);
    
    // Check each local rem
    for (const rem of remsToCheck) {
      if (processedRemIds.has(rem._id)) continue;
      processedRemIds.add(rem._id);
      
      const remText = await safeRemTextToString(plugin, rem.text);
      console.log(`Checking rem: "${remText}" (${rem._id})`);
      
      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
      
      if (foundPDF) {
        console.log(`  - Found PDF: ${foundPDF._id}, Target PDF: ${pdfRemId}, Match: ${foundPDF._id === pdfRemId}`);
      } else {
        console.log(`  - No matching PDF found in this rem`);
      }
      
      if (foundPDF && foundPDF._id === pdfRemId) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        
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
        
        console.log(`✓ ADDED: "${remText}" (Incremental: ${isIncremental}, Range: ${range ? `${range.start}-${range.end}` : 'none'})`);
      }
    }
    
    // ===== PART 2: COMPREHENSIVE SEARCH for all incremental rems =====
    console.log('\n===== PART 2: Searching all incremental rems from cache =====');
    
    const allIncrementalRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];
    console.log(`Found ${allIncrementalRems.length} incremental rems in cache`);
    
    for (const incRemInfo of allIncrementalRems) {
      if (processedRemIds.has(incRemInfo.remId)) {
        console.log(`Skipping ${incRemInfo.remId} (already processed)`);
        continue;
      }
      
      const rem = await plugin.rem.findOne(incRemInfo.remId);
      if (!rem) continue;
      
      const remText = await safeRemTextToString(plugin, rem.text);
      
      // Check if this is a PDF highlight (skip if it is)
      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.Highlight);
      if (isPdfHighlight) {
        console.log(`Skipping "${remText}" (PDF highlight, not a reading incremental)`);
        continue;
      }
      
      // Check if this incremental rem has the target PDF
      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
      
      if (foundPDF && foundPDF._id === pdfRemId) {
        const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
        const currentPage = await getIncrementalReadingPosition(plugin, rem._id, pdfRemId);
        
        result.push({
          remId: rem._id,
          name: remText,
          range,
          currentPage,
          isIncremental: true // All items in this search are incremental
        });
        
        processedRemIds.add(rem._id);
        console.log(`✓ ADDED: "${remText}" (Incremental: true, Range: ${range ? `${range.start}-${range.end}` : 'none'})`);
      }
    }
    
    // Check known rems from storage
    const knownRemsKey = getKnownPdfRemsKey(pdfRemId);
    let knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
    
    for (const remId of knownRemIds) {
      if (processedRemIds.has(remId)) continue;
      
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        const remText = await safeRemTextToString(plugin, rem.text); // FIXED
        
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
    
    // Update the known rems list
    const allFoundRemIds = Array.from(processedRemIds);
    await plugin.storage.setSynced(knownRemsKey, allFoundRemIds);
    
    // Sort results
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