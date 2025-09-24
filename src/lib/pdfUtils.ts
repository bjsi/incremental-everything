// lib/pdfUtils.ts
import { RNPlugin, Rem, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode } from './consts';

/**
 * Generate key for storing a persistent list of rems known to be associated with a PDF.
 */
const getKnownPdfRemsKey = (pdfRemId: string) => `known_pdf_rems_${pdfRemId}`;

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
  return savedRange && typeof savedRange === 'object' ? savedRange as {start: number, end: number} : null;
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
  
  if (Array.isArray(history)) {
    return history.map(entry => {
      if (typeof entry === 'number') {
        return { page: entry, timestamp: 0 };
      } else if (entry && typeof entry.page === 'number') {
        return entry;
      }
      return null;
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
  
  const entry = { page, timestamp: Date.now() };
  history.push(entry);
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
 * Discovers and retrieves a persistent list of Rems associated with a PDF.
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
  console.log(`[getAllIncrementsForPDF] Processing PDF: ${pdfRemId}`);
  const knownRemsKey = getKnownPdfRemsKey(pdfRemId);

  // 1. Get the list of already known related Rem IDs from storage.
  let knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
  console.log(`[getAllIncrementsForPDF] Found ${knownRemIds.length} known related rems in storage.`);

  // 2. Discover new relationships by searching only within current incremental rems.
  const powerup = await plugin.powerup.getPowerupByCode(powerupCode);
  const allIncrementalRems = (await powerup?.taggedRem()) || [];
  let newRemsFound = false;

  for (const incRem of allIncrementalRems) {
    // If this incremental rem isn't already in our known list, check it.
    if (!knownRemIds.includes(incRem._id)) {
      const sources = await incRem.getSources();
      if (sources.some(s => s._id === pdfRemId)) {
        console.log(`[getAllIncrementsForPDF] Discovered new related incremental rem: ${incRem._id}`);
        knownRemIds.push(incRem._id);
        newRemsFound = true;
      }
    }
  }

  // 3. If we found any new rems, update the stored list.
  if (newRemsFound) {
    console.log(`[getAllIncrementsForPDF] Saving updated list of ${knownRemIds.length} known rems.`);
    await plugin.storage.setSynced(knownRemsKey, knownRemIds);
  }

  // 4. Build the final list of objects from our potentially updated list of IDs.
  const result = [];
  for (const remId of knownRemIds) {
    const rem = await plugin.rem.findOne(remId);
    if (rem) {
      // Check the CURRENT status of the rem.
      const isIncremental = await rem.hasPowerup(powerupCode);
      const remText = rem.text ? await plugin.richText.toString(rem.text) : 'Untitled';
      const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
      const currentPage = isIncremental ? await getIncrementalReadingPosition(plugin, rem._id, pdfRemId) : null;
      
      result.push({
        remId: rem._id,
        name: remText,
        range,
        currentPage,
        isIncremental
      });
    }
  }

  // 5. Sort and return.
  result.sort((a, b) => {
    if (a.isIncremental !== b.isIncremental) return a.isIncremental ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  
  console.log(`[getAllIncrementsForPDF] Returning ${result.length} total related rems.`);
  return result;
};

/**
 * Clear all data for a rem + PDF combination
 */
export const clearIncrementalPDFData = async (
  plugin: RNPlugin,
  remId: string,
  pdfRemId: string
): Promise<void> => {
  const pageKey = getCurrentPageKey(remId, pdfRemId);
  const rangeKey = getPageRangeKey(remId, pdfRemId);
  const historyKey = getPageHistoryKey(remId, pdfRemId);
  
  await plugin.storage.setSynced(pageKey, null);
  await plugin.storage.setSynced(rangeKey, null);
  await plugin.storage.setSynced(historyKey, null);
};

