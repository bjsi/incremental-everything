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
    
    // Get the PDF rem
    const pdfRem = await plugin.rem.findOne(pdfRemId);
    if (!pdfRem) return result;
    
    console.log('Searching for rems using PDF:', pdfRemId);
    
    // Get the list of already known related Rem IDs from persistent storage
    const knownRemsKey = getKnownPdfRemsKey(pdfRemId);
    let knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
    console.log(`Found ${knownRemIds.length} known related rems in storage.`);
    
    // Method 1: Add all previously known rems first (includes formerly incremental rems)
    for (const remId of knownRemIds) {
      if (processedRemIds.has(remId)) continue;
      
      const rem = await plugin.rem.findOne(remId);
      if (rem) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        const remText = rem.text ? await plugin.richText.toString(rem.text) : 'Untitled';
        
        // Check if it still has page range data (even if no longer incremental)
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
        console.log('Found known rem:', remText, 'Incremental:', isIncremental, 'Has range:', !!range);
      }
    }
    
    // Method 2: Search through ALL rems with the incremental powerup
    const powerup = await plugin.powerup.getPowerupByCode(powerupCode);
    const allIncrementalRems = (await powerup?.taggedRem()) || [];
    console.log('Found', allIncrementalRems.length, 'incremental rems');
    
    for (const rem of allIncrementalRems) {
      if (processedRemIds.has(rem._id)) continue;
      
      // Check if this incremental rem or its descendants contain/reference the PDF
      const descendants = await rem.getDescendants();
      const sources = await rem.getSources();
      
      const containsPDF = rem._id === pdfRemId || 
                          descendants.some(d => d._id === pdfRemId) ||
                          sources.some(s => s._id === pdfRemId);
      
      if (containsPDF) {
        const remText = rem.text ? await plugin.richText.toString(rem.text) : 'Untitled';
        const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
        const currentPage = await getIncrementalReadingPosition(plugin, rem._id, pdfRemId);
        
        result.push({
          remId: rem._id,
          name: remText,
          range,
          currentPage,
          isIncremental: true
        });
        processedRemIds.add(rem._id);
        
        // Add to known rems for future reference
        if (!knownRemIds.includes(rem._id)) {
          knownRemIds.push(rem._id);
        }
        
        console.log('Found incremental rem using PDF:', remText);
      }
    }
    
    // Method 3: Check all siblings and descendants in the document structure
    if (pdfRem.parent) {
      try {
        const parentRem = await plugin.rem.findOne(pdfRem.parent);
        if (parentRem) {
          // Get all siblings (children of the same parent)
          const siblings = await parentRem.getChildrenRem();
          console.log('Found', siblings.length, 'siblings of the PDF');
          
          for (const sibling of siblings) {
            if (processedRemIds.has(sibling._id)) continue;
            if (sibling._id === pdfRemId) continue; // Skip the PDF itself
            
            // Check if this sibling references the PDF as a source
            const sources = await sibling.getSources();
            const referencesPDF = sources.some(s => s._id === pdfRemId);
            
            // Also check if the sibling contains the PDF in its descendants
            const siblingDescendants = await sibling.getDescendants();
            const containsPDF = siblingDescendants.some(d => d._id === pdfRemId);
            
            if (referencesPDF || containsPDF) {
              const isIncremental = await sibling.hasPowerup(powerupCode);
              const siblingText = sibling.text ? 
                await plugin.richText.toString(sibling.text) : 'Untitled';
              
              const range = await getIncrementalPageRange(plugin, sibling._id, pdfRemId);
              const currentPage = isIncremental ? 
                await getIncrementalReadingPosition(plugin, sibling._id, pdfRemId) : null;
              
              result.push({
                remId: sibling._id,
                name: siblingText,
                range,
                currentPage,
                isIncremental
              });
              processedRemIds.add(sibling._id);
              
              // Add to known rems for future reference
              if (!knownRemIds.includes(sibling._id)) {
                knownRemIds.push(sibling._id);
              }
              
              console.log('Found sibling rem using PDF:', siblingText, 'Incremental:', isIncremental);
            }
            
            // Check descendants of siblings
            for (const desc of siblingDescendants) {
              if (processedRemIds.has(desc._id)) continue;
              
              const descSources = await desc.getSources();
              if (descSources.some(s => s._id === pdfRemId)) {
                const isIncremental = await desc.hasPowerup(powerupCode);
                const descText = desc.text ? 
                  await plugin.richText.toString(desc.text) : 'Untitled';
                
                const range = await getIncrementalPageRange(plugin, desc._id, pdfRemId);
                const currentPage = isIncremental ? 
                  await getIncrementalReadingPosition(plugin, desc._id, pdfRemId) : null;
                
                result.push({
                  remId: desc._id,
                  name: descText,
                  range,
                  currentPage,
                  isIncremental
                });
                processedRemIds.add(desc._id);
                
                // Add to known rems for future reference
                if (!knownRemIds.includes(desc._id)) {
                  knownRemIds.push(desc._id);
                }
                
                console.log('Found descendant using PDF:', descText, 'Incremental:', isIncremental);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error checking siblings:', error);
      }
    }
    
    // Save the updated list of known rems for future use
    await plugin.storage.setSynced(knownRemsKey, knownRemIds);
    console.log('Saved', knownRemIds.length, 'known rems for future reference');
    
    // Sort results: incremental rems first, then by name
    result.sort((a, b) => {
      if (a.isIncremental !== b.isIncremental) {
        return a.isIncremental ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    
    console.log('Total rems found using PDF:', result.length);
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