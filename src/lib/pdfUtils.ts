// lib/pdfUtils.ts
import { RNPlugin, PluginRem, RemId, BuiltInPowerupCodes } from '@remnote/plugin-sdk';
import { powerupCode, allIncrementalRemKey, incremReviewStartTimeKey } from './consts';
import { IncrementalRem } from './incremental_rem/types';

export interface PageRangeContext {
  incrementalRemId: RemId | null;
  pdfRemId: RemId;
  totalPages: number;
  currentPage: number;
  /**
   * All PDF rem IDs available for the IncRem, when known at popup-open time.
   * Used by the panel's PDF selector for instant render. Undefined when the
   * popup enters from a path that hasn't resolved the IncRem yet (the widget
   * computes the list itself once the IncRem is resolved).
   */
  allPdfRemIds?: RemId[];
}

/**
 * Enhanced structure for page history entries with duration tracking
 */
export interface PageHistoryEntry {
  // Optional: HTML articles and PDF Text Reader highlights have no page number.
  page?: number;
  timestamp: number;
  sessionDuration?: number;   // Duration in seconds for this reading session
  highlightId?: string;       // Rem ID of the specific highlight mapped to this bookmark
}

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
): Promise<{ start: number, end: number } | null> => {
  const rangeKey = getPageRangeKey(incrementalRemId, pdfRemId);
  const savedRange = await plugin.storage.getSynced(rangeKey);
  return savedRange && typeof savedRange === 'object' && 'start' in savedRange
    ? savedRange as { start: number, end: number }
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
): Promise<PageHistoryEntry[]> => {
  const historyKey = getPageHistoryKey(incrementalRemId, pdfRemId);
  const history = await plugin.storage.getSynced(historyKey);

  // Handle both old format (just numbers) and new format (with timestamps)
  if (Array.isArray(history)) {
    return history.map(entry => {
      if (typeof entry === 'number') {
        // Old format: just page number, no timestamp
        return { page: entry, timestamp: 0 };
      } else if (entry && (typeof entry.page === 'number' || entry.highlightId)) {
        // Accept entries with a real page number (PDF Reader) OR with a
        // highlightId but no page (HTML / PDF Text Reader bookmarks).
        return {
          page: typeof entry.page === 'number' ? entry.page : undefined,
          timestamp: entry.timestamp || 0,
          sessionDuration: entry.sessionDuration,
          highlightId: entry.highlightId
        };
      } else {
        // Invalid entry
        return null;
      }
    }).filter(Boolean) as PageHistoryEntry[];
  }

  return [];
};

/**
 * Add a page to the reading history with timestamp and session duration
 * FIXED: Now properly uses the current page from the reading session
 * 
 * @param plugin - The RemNote plugin instance
 * @param incrementalRemId - The incremental rem ID
 * @param pdfRemId - The PDF rem ID  
 * @param pageToRecord - Optional page number to record. If not provided, uses the current reading position
 */
export const addPageToHistory = async (
  plugin: RNPlugin,
  incrementalRemId: string,
  pdfRemId: string,
  // Pass `null` for non-paginated sources (HTML / PDF Text Reader). Pass
  // `undefined` to derive the page from the saved reading position.
  pageToRecord?: number | null,
  sessionDurationOverride?: number,
  highlightId?: string
): Promise<void> => {
  console.log(`[addPageToHistory] Triggered for Rem: ${incrementalRemId}`);

  const historyKey = getPageHistoryKey(incrementalRemId, pdfRemId);

  // Get the page to record. `null` = explicit "no page" (HTML/text reader).
  let page: number | undefined;
  if (pageToRecord === null) {
    page = undefined;
  } else if (pageToRecord !== undefined) {
    page = pageToRecord;
  } else {
    // Get the actual current reading position instead of defaulting to 1
    const currentPage = await getIncrementalReadingPosition(plugin, incrementalRemId, pdfRemId);
    page = currentPage || 1;
  }

  let sessionDuration: number | undefined;

  // --- DIRECT CALCULATION LOGIC ---
  if (sessionDurationOverride !== undefined) {
    if (sessionDurationOverride > 2) {
      if (sessionDurationOverride > 14400) {
        console.log(`[addPageToHistory] ⚠️ Override duration too long (${sessionDurationOverride}s). Ignoring.`);
      } else {
        sessionDuration = sessionDurationOverride;
        console.log(`[addPageToHistory] ✅ SAVED Override Duration: ${sessionDuration}s`);
      }
    }
  } else {
    try {
      const startTime = await plugin.storage.getSession<number>(incremReviewStartTimeKey);

      if (startTime) {
        const calculatedDuration = Math.round((Date.now() - startTime) / 1000);

        // ✅ FILTER: Only record meaningful sessions (> 2 seconds)
        // This ignores the "0s" noise from React re-renders
        if (calculatedDuration > 2) {
          if (calculatedDuration > 14400) {
            console.log(`[addPageToHistory] ⚠️ Duration too long (${calculatedDuration}s). Ignoring.`);
          } else {
            sessionDuration = calculatedDuration;
            console.log(`[addPageToHistory] ✅ SAVED Duration: ${sessionDuration}s`);
          }
        }
      }
    } catch (e) {
      console.error("[addPageToHistory] Error calculating duration:", e);
    }
  }
  // --------------------------------

  const history = await getPageHistory(plugin, incrementalRemId, pdfRemId);

  // Bookmark preservation: when no highlightId is supplied (e.g. queue "Next",
  // session-end timers, manual page save) but the most-recent same-page entry
  // carries one, inherit it. Otherwise, that anonymous entry would shadow a
  // just-saved highlight bookmark under the "last entry only" detection used
  // by the Scroll-to-Position buttons. Same physical page, same bookmark intent.
  let effectiveHighlightId = highlightId;
  if (!effectiveHighlightId) {
    for (let i = history.length - 1; i >= 0; i--) {
      const prev = history[i];
      if (prev.highlightId && prev.page === page) {
        effectiveHighlightId = prev.highlightId;
        console.log(`[addPageToHistory] Preserving bookmark highlightId from prior same-page entry: ${effectiveHighlightId}`);
        break;
      }
      // Stop scanning past a different-page entry — the bookmark intent ended there.
      if (prev.page !== page) break;
    }
  }

  const entry: PageHistoryEntry = {
    page,
    timestamp: Date.now(),
    sessionDuration,
    highlightId: effectiveHighlightId
  };

  history.push(entry);

  // Keep only last 100 entries to avoid storage bloat
  const trimmedHistory = history.slice(-100);

  await plugin.storage.setSynced(historyKey, trimmedHistory);
};

/**
 * Calculate total time spent reading for a specific rem/PDF combination
 * Only counts sessions with recorded duration (from queue reading)
 */
export const getTotalReadingTime = async (
  plugin: RNPlugin,
  incrementalRemId: string,
  pdfRemId: string
): Promise<number> => {
  const history = await getPageHistory(plugin, incrementalRemId, pdfRemId);

  return history.reduce((total, entry) => {
    return total + (entry.sessionDuration || 0);
  }, 0);
};

/**
 * Get reading statistics for a rem/PDF combination
 */
export const getReadingStatistics = async (
  plugin: RNPlugin,
  incrementalRemId: string,
  pdfRemId: string
): Promise<{
  totalSessions: number;
  totalTimeSeconds: number;
  totalTimeMinutes: number;
  averageSessionSeconds: number;
  lastSessionDate?: number;
  lastSessionDuration?: number;
  pagesRead: Set<number>;
  sessionsWithTime: number;
}> => {
  const history = await getPageHistory(plugin, incrementalRemId, pdfRemId);

  const totalTimeSeconds = history.reduce((total, entry) => {
    return total + (entry.sessionDuration || 0);
  }, 0);

  const sessionsWithDuration = history.filter(entry => entry.sessionDuration);
  const averageSessionSeconds = sessionsWithDuration.length > 0
    ? totalTimeSeconds / sessionsWithDuration.length
    : 0;

  const lastEntry = history[history.length - 1];

  return {
    totalSessions: history.length,
    totalTimeSeconds,
    totalTimeMinutes: Math.round(totalTimeSeconds / 60),
    averageSessionSeconds: Math.round(averageSessionSeconds),
    lastSessionDate: lastEntry?.timestamp,
    lastSessionDuration: lastEntry?.sessionDuration,
    pagesRead: new Set(history.map(e => e.page).filter((p): p is number => typeof p === 'number')),
    sessionsWithTime: sessionsWithDuration.length
  };
};

/**
 * Finds the incremental rem associated with a PDF.
 * Searches in this order:
 * 1. Check if the PDF itself is incremental
 * 2. Check widget context (if available)
 * 3. Check parent rem
 * 4. Search all incremental rems to find one that contains this PDF
 *
 * @param plugin - The RemNote plugin instance
 * @param pdfRem - The PDF rem to find the incremental rem for
 * @param checkWidgetContext - Whether to check widget context (default: false, use true in Reader)
 * @returns The incremental rem, or null if not found
 */
/**
 * Fast path to find the incremental rem for a PDF.
 * Resolution order (all fast):
 *   1. PDF itself is incremental
 *   2. Parent rem is incremental
 *   3. Known-rems synced cache contains an incremental rem for this PDF
 * Falls back to the full expensive search only if none of the above works.
 */
export const findIncrementalRemForPDFFast = async (
  plugin: RNPlugin,
  pdfRem: PluginRem
): Promise<PluginRem | null> => {
  // 1. PDF itself
  if (await pdfRem.hasPowerup(powerupCode)) {
    console.log(`[findIncRemFast] PDF itself is incremental (${pdfRem._id})`);
    return pdfRem;
  }

  // 2. Parent
  if (pdfRem.parent) {
    try {
      const parentRem = await plugin.rem.findOne(pdfRem.parent);
      if (parentRem && (await parentRem.hasPowerup(powerupCode))) {
        console.log(`[findIncRemFast] Found via parent (${parentRem._id})`);
        return parentRem;
      }
    } catch (e) { /* ignore */ }
  }

  // 3. Known-rems cache — check if any stored rem is incremental and has this PDF
  const knownRemsKey = getKnownPdfRemsKey(pdfRem._id);
  const knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
  for (const remId of knownRemIds) {
    const rem = await plugin.rem.findOne(remId);
    if (!rem) continue;
    if (await rem.hasPowerup(powerupCode)) {
      console.log(`[findIncRemFast] Found via known-rems cache (${remId})`);
      return rem;
    }
  }

  // 4. Expensive full scan as last resort
  console.log('[findIncRemFast] Cache miss — falling back to full scan');
  return findIncrementalRemForPDF(plugin, pdfRem, false);
};

export const findIncrementalRemForPDF = async (
  plugin: RNPlugin,
  pdfRem: PluginRem,
  checkWidgetContext: boolean = false
): Promise<PluginRem | null> => {
  if (await pdfRem.hasPowerup(powerupCode)) {
    console.log(`[findIncrementalRemForPDF] PDF itself is incremental (${pdfRem._id})`);
    return pdfRem;
  }

  if (checkWidgetContext) {
    try {
      const widgetContext = await plugin.widget.getWidgetContext();
      const contextRemId =
        widgetContext && 'remId' in widgetContext && widgetContext.remId
          ? widgetContext.remId
          : null;

      if (contextRemId && contextRemId !== pdfRem._id) {
        const contextRem = await plugin.rem.findOne(contextRemId);
        if (contextRem && (await contextRem.hasPowerup(powerupCode))) {
          console.log(`[findIncrementalRemForPDF] Found via widget context (${contextRem._id})`);
          return contextRem;
        }
      }
    } catch (e) {
      console.error('[findIncrementalRemForPDF] Error checking widget context:', e);
    }
  }

  if (pdfRem.parent) {
    try {
      const parentRem = await plugin.rem.findOne(pdfRem.parent);
      if (parentRem && (await parentRem.hasPowerup(powerupCode))) {
        console.log(`[findIncrementalRemForPDF] Found via parent (${parentRem._id})`);
        return parentRem;
      }
    } catch (e) {
      console.error('[findIncrementalRemForPDF] Error checking parent:', e);
    }
  }

  try {
    const incPowerup = await plugin.powerup.getPowerupByCode(powerupCode);
    if (incPowerup) {
      const allIncRems = await incPowerup.taggedRem();
      for (const candidateRem of allIncRems) {
        const foundPDF = await findPDFinRem(plugin, candidateRem, pdfRem._id);
        if (foundPDF) {
          console.log(`[findIncrementalRemForPDF] Found via sources search (${candidateRem._id})`);
          return candidateRem;
        }

        try {
          const descendants = await candidateRem.getDescendants();
          if (descendants.some((desc) => desc._id === pdfRem._id)) {
            console.log(`[findIncrementalRemForPDF] Found via descendants search (${candidateRem._id})`);
            return candidateRem;
          }
        } catch (e) {
          // Continue searching other candidates
        }
      }
    }
  } catch (e) {
    console.error('[findIncrementalRemForPDF] Error searching incremental rems:', e);
  }

  console.log(`[findIncrementalRemForPDF] No incremental rem found for PDF ${pdfRem._id}`);
  return null;
};

/**
 * Finds a specific PDF Rem within a given Rem or its sources.
 * If targetPdfId is provided, searches for that specific PDF.
 * If not provided, returns the first PDF found.
 */
export const findPDFinRem = async (
  plugin: RNPlugin,
  rem: PluginRem,
  targetPdfId?: string
): Promise<PluginRem | null> => {
  const isUploadedPdf = async (r: PluginRem): Promise<boolean> => {
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
      // console.log(`    [findPDFinRem] Rem itself is a PDF (${rem._id})`);
      return rem;
    }
  }

  // Check sources
  const sources = await rem.getSources();
  // console.log(`    [findPDFinRem] Checking ${sources.length} sources`);

  const foundPdfs: PluginRem[] = [];

  for (const source of sources) {
    if (await isUploadedPdf(source)) {
      const sourceText = await safeRemTextToString(plugin, source.text);
      // console.log(`    [findPDFinRem] Found PDF in source: "${sourceText}" (${source._id})`);
      foundPdfs.push(source);

      // If we're looking for a specific PDF and found it, return immediately
      if (targetPdfId && source._id === targetPdfId) {
        // console.log(`    [findPDFinRem] ✓ MATCH! This is the target PDF`);
        return source;
      }
    }
  }

  // If we have a target PDF but didn't find it, return null
  if (targetPdfId) {
    // console.log(`    [findPDFinRem] Found ${foundPdfs.length} PDF(s) but none matched target ${targetPdfId}`);
    return null;
  }

  // If no target specified, return the first PDF found (backward compatibility)
  return foundPdfs.length > 0 ? foundPdfs[0] : null;
};

/**
 * Enumerate every PDF source attached to a rem, flagging which carry the
 * `#preferthispdf` tag. The rem itself is included if it is an uploaded PDF.
 *
 * This is the building block for `findPreferredPDFInRem` (legacy strict
 * resolver) and `getActivePdfForIncRem` (active-PDF-aware resolver).
 */
export const getAllPDFsInRem = async (
  plugin: RNPlugin,
  rem: PluginRem
): Promise<Array<{ rem: PluginRem; isPreferred: boolean }>> => {
  const isUploadedPdf = async (r: PluginRem): Promise<boolean> => {
    if (!(await r.hasPowerup(BuiltInPowerupCodes.UploadedFile))) return false;
    try {
      const url = await r.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'URL');
      return typeof url === 'string' && url.toLowerCase().endsWith('.pdf');
    } catch {
      return false;
    }
  };

  const hasPreferTag = async (r: PluginRem): Promise<boolean> => {
    try {
      const tags = await r.getTagRems();
      for (const tagRem of tags) {
        if (!tagRem.text) continue;
        const tagText = (await safeRemTextToString(plugin, tagRem.text))
          .toLowerCase()
          .replace(/\s+/g, '');
        if (tagText === 'preferthispdf') return true;
      }
    } catch {
      // Ignore tag-read errors for individual PDFs
    }
    return false;
  };

  const result: Array<{ rem: PluginRem; isPreferred: boolean }> = [];

  if (await isUploadedPdf(rem)) {
    result.push({ rem, isPreferred: await hasPreferTag(rem) });
  }

  const sources = await rem.getSources();
  for (const source of sources) {
    if (await isUploadedPdf(source)) {
      result.push({ rem: source, isPreferred: await hasPreferTag(source) });
    }
  }

  return result;
};

/**
 * Storage key for the user's explicitly chosen "active PDF" on an IncRem.
 * Lets the user pin a non-preferred PDF as the focus of their work without
 * editing tags.
 */
export const getActivePdfKey = (incRemId: string) => `active_pdf_for_${incRemId}`;

/**
 * Pin a PDF as the active one for an IncRem. Pass `null` to clear the pin.
 */
export const setActivePdfForIncRem = async (
  plugin: RNPlugin,
  incRemId: string,
  pdfRemId: string | null
): Promise<void> => {
  await plugin.storage.setSynced(getActivePdfKey(incRemId), pdfRemId);
};

/**
 * Resolve the PDF the user is currently focused on for an IncRem.
 *
 * Resolution order:
 *   1. Explicit active PDF (`active_pdf_for_${remId}`) if still a source —
 *      stale stored IDs are auto-cleared.
 *   2. PDF tagged `#preferthispdf`. With multiple such PDFs:
 *        - strict mode → null (caller communicates the conflict).
 *        - default mode → first preferred PDF (graceful fallback).
 *   3. First PDF source found.
 *
 * Returns null only if the rem has no PDFs, or if strict mode hit a
 * multi-preferred conflict.
 */
export const getActivePdfForIncRem = async (
  plugin: RNPlugin,
  rem: PluginRem,
  opts: { strict?: boolean } = {}
): Promise<PluginRem | null> => {
  const allPdfs = await getAllPDFsInRem(plugin, rem);
  if (allPdfs.length === 0) return null;
  if (allPdfs.length === 1) return allPdfs[0].rem;

  // 1. Explicit active PDF
  const activeId = await plugin.storage.getSynced<string>(getActivePdfKey(rem._id));
  if (activeId) {
    const match = allPdfs.find(p => p.rem._id === activeId);
    if (match) return match.rem;
    // Stored PDF is no longer a source — clear the stale pin.
    await plugin.storage.setSynced(getActivePdfKey(rem._id), null);
  }

  // 2. Preferred PDF (#preferthispdf)
  const preferred = allPdfs.filter(p => p.isPreferred);
  if (preferred.length === 1) return preferred[0].rem;
  if (preferred.length > 1) {
    if (opts.strict) return null;
    return preferred[0].rem;
  }

  // 3. First PDF source
  return allPdfs[0].rem;
};

/**
 * Finds the best PDF for a given rem, respecting the `#preferthispdf` tag.
 *
 * Resolution order:
 *  1. If the rem has no PDF sources → null.
 *  2. If the rem has exactly one PDF source → return it.
 *  3. If one source is tagged `#preferthispdf` → return that one.
 *  4. If multiple sources carry the tag → toast a warning and return null
 *     (caller should fall back to the standard ExtractViewer path).
 *  5. If no source has the tag → return the first PDF found (legacy behaviour).
 *
 * Strict resolver — does NOT consult the per-IncRem "active PDF" pin. Prefer
 * `getActivePdfForIncRem` for new code; this remains for call sites that
 * specifically want the multi-preferred conflict toast (e.g. legacy paths).
 */
export const findPreferredPDFInRem = async (
  plugin: RNPlugin,
  rem: PluginRem,
  /** If true, show a toast when multiple #preferthispdf tags are found */
  showWarningToast: boolean = true
): Promise<PluginRem | null> => {
  const allPdfs = await getAllPDFsInRem(plugin, rem);
  if (allPdfs.length === 0) return null;
  if (allPdfs.length === 1) return allPdfs[0].rem;

  const preferred = allPdfs.filter(p => p.isPreferred);
  if (preferred.length === 1) return preferred[0].rem;

  if (preferred.length > 1 && showWarningToast) {
    await plugin.app.toast(
      'Multiple PDFs have the #preferthispdf tag — cannot determine which to open. Add the tag to exactly one PDF source.'
    );
    return null;
  }

  // No tag found — fall back to first PDF (legacy behaviour)
  return allPdfs[0].rem;
};

/**
 * Generate key for storing a persistent list of rems known to be associated with a PDF.
 */
export const getKnownPdfRemsKey = (pdfRemId: string) => `known_pdf_rems_${pdfRemId}`;

/**
 * Register one or more rem IDs as known users of a specific HTML article.
 * Mirror of registerRemsAsPdfKnown for HTML hosts. Idempotent.
 * (The key generator getKnownHtmlRemsKey is defined further below alongside
 * the other HTML-related helpers.)
 */
export const registerRemsAsHtmlKnown = async (
  plugin: RNPlugin,
  htmlRemId: string,
  remIds: string[]
): Promise<void> => {
  const key = getKnownHtmlRemsKey(htmlRemId);
  const existing = (await plugin.storage.getSynced<string[]>(key)) || [];
  const existingSet = new Set(existing);
  let changed = false;
  for (const id of remIds) {
    if (!existingSet.has(id)) {
      existingSet.add(id);
      changed = true;
    }
  }
  if (changed) {
    await plugin.storage.setSynced(key, Array.from(existingSet));
  }
};

/**
 * Register one or more rem IDs as known users of a specific PDF in synced storage.
 * This is the index that getAllIncrementsForPDF and findAllRemsForPDF rely on to
 * discover rems that were not found via the local parent/sibling search.
 *
 * Idempotent — existing IDs are not re-added.
 */
export const registerRemsAsPdfKnown = async (
  plugin: RNPlugin,
  pdfRemId: string,
  remIds: string[]
): Promise<void> => {
  const key = getKnownPdfRemsKey(pdfRemId);
  const existing = (await plugin.storage.getSynced<string[]>(key)) || [];
  const existingSet = new Set(existing);
  let changed = false;
  for (const id of remIds) {
    if (!existingSet.has(id)) {
      existingSet.add(id);
      changed = true;
    }
  }
  if (changed) {
    await plugin.storage.setSynced(key, Array.from(existingSet));
  }
};

/**
 * Get descendants up to a specified depth
 */
export const getDescendantsToDepth = async (rem: PluginRem, maxDepth: number): Promise<PluginRem[]> => {
  const result: PluginRem[] = [];

  const collectDescendants = async (currentRem: PluginRem, currentDepth: number) => {
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

/** Shared entry type for rems associated with a PDF. */
export type PdfRemEntry = {
  remId: string;
  name: string;
  range: { start: number, end: number } | null;
  currentPage: number | null;
  isIncremental: boolean;
};

/** Shared sort for PdfRemEntry arrays: incremental first, then alphabetical. */
const sortPdfRemEntries = (entries: PdfRemEntry[]) =>
  entries.sort((a, b) => {
    if (a.isIncremental !== b.isIncremental) return a.isIncremental ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

/**
 * INSTANT phase: reads only from the known-rems synced index for this specific PDF.
 * Typically O(12) lookups — renders in well under 100ms.
 * Does NOT scan the global session cache.
 */
export const getInstantRemsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string,
  alreadyFound: Set<string> = new Set()
): Promise<{ results: PdfRemEntry[]; processedIds: Set<string> }> => {
  const t0 = performance.now();
  const results: PdfRemEntry[] = [];
  const processedIds = new Set<string>(alreadyFound);

  try {
    console.log('\n===== INSTANT: Checking known-rems index =====');
    const knownRemsKey = getKnownPdfRemsKey(pdfRemId);
    const knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
    console.log(`Known-rems index has ${knownRemIds.length} entries for this PDF`);

    for (const remId of knownRemIds) {
      if (processedIds.has(remId)) continue;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) continue;

      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (isPdfHighlight) continue;

      // Verify the PDF association is still valid
      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
      if (foundPDF && foundPDF._id === pdfRemId) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        const remText = await safeRemTextToString(plugin, rem.text);
        const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
        const currentPage = await getIncrementalReadingPosition(plugin, rem._id, pdfRemId);
        results.push({ remId: rem._id, name: remText, range, currentPage, isIncremental });
        processedIds.add(rem._id);
        console.log(`✓ INSTANT ADDED: "${remText}" (Incremental: ${isIncremental})`);
      }
    }
    // Self-heal: trim the stored index to only the IDs that still have this PDF.
    // This undoes the historical pollution caused by the old slow-phase logic.
    const verifiedIds = results.map(r => r.remId);
    await plugin.storage.setSynced(knownRemsKey, verifiedIds);
  } catch (error) {
    console.error('[getInstantRemsForPDF] Error:', error);
  }

  console.log(`⏱ INSTANT phase: ${(performance.now() - t0).toFixed(0)}ms, found ${results.length} rems`);
  return { results, processedIds };
};

/**
 * CACHE phase: scans all incremental rems in the session cache to find ones
 * associated with this PDF that aren't already in the known-rems index.
 * O(allIncrementalRems) — can be ~seconds for large KBs, run in background.
 */
export const getCacheRemsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string,
  alreadyFound: Set<string> = new Set()
): Promise<{ results: PdfRemEntry[]; processedIds: Set<string> }> => {
  const t0 = performance.now();
  const results: PdfRemEntry[] = [];
  const processedIds = new Set<string>(alreadyFound);

  try {
    console.log('\n===== CACHE: Scanning session cache for new rems =====');
    const allIncrementalRems =
      (await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey)) || [];
    console.log(`Scanning ${allIncrementalRems.length} incremental rems in cache`);

    for (const incRemInfo of allIncrementalRems) {
      if (processedIds.has(incRemInfo.remId)) continue;

      const rem = await plugin.rem.findOne(incRemInfo.remId);
      if (!rem) continue;

      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (isPdfHighlight) continue;

      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
      if (foundPDF && foundPDF._id === pdfRemId) {
        const remText = await safeRemTextToString(plugin, rem.text);
        const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
        const currentPage = await getIncrementalReadingPosition(plugin, rem._id, pdfRemId);
        results.push({ remId: rem._id, name: remText, range, currentPage, isIncremental: true });
        processedIds.add(rem._id);
        console.log(`✓ CACHE ADDED: "${remText}" (Range: ${range ? `${range.start}-${range.end}` : 'none'})`);
      }
    }
  } catch (error) {
    console.error('[getCacheRemsForPDF] Error:', error);
  }

  console.log(`⏱ CACHE phase: ${(performance.now() - t0).toFixed(0)}ms, found ${results.length} new rems`);
  return { results, processedIds };
};

/**
 * FAST phase: INSTANT (known-rems index) + CACHE (session scan) combined.
 * Kept for backward compatibility with getAllIncrementsForPDF.
 */
export const getFastRemsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string,
  alreadyFound: Set<string> = new Set()
): Promise<{ results: PdfRemEntry[]; processedIds: Set<string> }> => {
  const { results: instantResults, processedIds: afterInstant } =
    await getInstantRemsForPDF(plugin, pdfRemId, alreadyFound);

  const { results: cacheResults, processedIds: afterCache } =
    await getCacheRemsForPDF(plugin, pdfRemId, afterInstant);

  return {
    results: [...instantResults, ...cacheResults],
    processedIds: afterCache,
  };
};


/**
 * SLOW phase: walks the local parent/sibling/descendant tree to discover
 * rems that aren't in any cache yet (e.g. rems added via Ctrl+Shift+F1).
 * Skips IDs already in `alreadyFound` and merges results into the known-rems index.
 */
export const getLocalRemsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string,
  alreadyFound: Set<string> = new Set()
): Promise<PdfRemEntry[]> => {
  const t0 = performance.now();
  const results: PdfRemEntry[] = [];

  try {
    const contextData = await plugin.storage.getSession<PageRangeContext | null>('pageRangeContext');
    const incrementalRemId = contextData?.incrementalRemId;
    if (!incrementalRemId) return results;

    const incrementalRem = await plugin.rem.findOne(incrementalRemId);
    if (!incrementalRem) return results;

    console.log('\n===== SLOW: Searching locally for non-incremental rems =====');

    const remsToCheck: PluginRem[] = [];
    const processSearchScope = new Set<string>();
    const processedRemIds = new Set<string>(alreadyFound);

    if (incrementalRem.parent) {
      const searchRoot = await plugin.rem.findOne(incrementalRem.parent);
      if (searchRoot) {
        if (!processSearchScope.has(searchRoot._id)) {
          remsToCheck.push(searchRoot);
          processSearchScope.add(searchRoot._id);
        }
        const siblings = await searchRoot.getChildrenRem();
        for (const sibling of siblings) {
          if (!processSearchScope.has(sibling._id)) {
            remsToCheck.push(sibling);
            processSearchScope.add(sibling._id);
          }
        }
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

    for (const rem of remsToCheck) {
      if (processedRemIds.has(rem._id)) continue;
      processedRemIds.add(rem._id);

      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
      if (foundPDF && foundPDF._id === pdfRemId) {
        const isIncremental = await rem.hasPowerup(powerupCode);
        const remText = await safeRemTextToString(plugin, rem.text);
        const range = await getIncrementalPageRange(plugin, rem._id, pdfRemId);
        const currentPage = await getIncrementalReadingPosition(plugin, rem._id, pdfRemId);
        results.push({ remId: rem._id, name: remText, range, currentPage, isIncremental });
        console.log(`✓ SLOW ADDED: "${remText}" (Incremental: ${isIncremental}, Range: ${range ? `${range.start}-${range.end}` : 'none'})`);
      }
    }

    // Persist only the IDs of rems that actually have this PDF.
    // We intentionally do NOT persist non-matching processedRemIds here —
    // that was the original bug that inflated the index to 3000+ entries.
    const knownRemsKey = getKnownPdfRemsKey(pdfRemId);
    const existing = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];
    const newMatchingIds = results.map(r => r.remId);
    const merged = new Set([...existing, ...newMatchingIds]);
    await plugin.storage.setSynced(knownRemsKey, Array.from(merged));

    console.log(`⏱ SLOW phase: ${(performance.now() - t0).toFixed(0)}ms, found ${results.length} additional rems`);
  } catch (error) {
    console.error('[getLocalRemsForPDF] Error:', error);
  }

  return results;
};

/**
 * Get all rems (incremental and non-incremental) that use a specific PDF
 */
export const getAllIncrementsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string
): Promise<PdfRemEntry[]> => {
  try {
    const pdfRem = await plugin.rem.findOne(pdfRemId);
    if (!pdfRem) return [];

    console.log('Searching for rems using PDF:', pdfRemId);

    // Fast phase (cache + known-rems index)
    const { results: fastResults, processedIds } = await getFastRemsForPDF(plugin, pdfRemId);

    // Slow phase — local tree walk, skipping already-found IDs
    const slowResults = await getLocalRemsForPDF(plugin, pdfRemId, processedIds);

    const combined = [...fastResults, ...slowResults];
    sortPdfRemEntries(combined);

    console.log(`Total rems found using PDF: ${combined.length}`);
    return combined;
  } catch (error) {
    console.error('Error getting rems for PDF:', error);
    return [];
  }
};

/**
 * Find all rems (incremental and non-incremental) that use a specific PDF.
 * This version does NOT depend on pageRangeContext - it searches globally.
 * Used by the parent selector when creating rems from PDF highlights.
 */
export const findAllRemsForPDF = async (
  plugin: RNPlugin,
  pdfRemId: string
): Promise<Array<{
  remId: string;
  name: string;
  isIncremental: boolean;
}>> => {
  try {
    const result: Array<{
      remId: string;
      name: string;
      isIncremental: boolean;
    }> = [];

    const processedRemIds = new Set<string>();

    // PART 1: Search all incremental rems from cache
    const allIncrementalRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];

    for (const incRemInfo of allIncrementalRems) {
      if (processedRemIds.has(incRemInfo.remId)) continue;

      const rem = await plugin.rem.findOne(incRemInfo.remId);
      if (!rem) continue;

      // Skip PDF highlights - we want parent rems only
      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (isPdfHighlight) continue;

      // Check if this incremental rem has the target PDF
      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);

      if (foundPDF && foundPDF._id === pdfRemId) {
        const remText = await safeRemTextToString(plugin, rem.text);
        result.push({
          remId: rem._id,
          name: remText,
          isIncremental: true
        });
        processedRemIds.add(rem._id);
      }
    }

    // PART 2: Check known rems from storage (includes non-incremental rems)
    const knownRemsKey = getKnownPdfRemsKey(pdfRemId);
    const knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];

    for (const remId of knownRemIds) {
      if (processedRemIds.has(remId)) continue;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) continue;

      // Skip PDF highlights
      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (isPdfHighlight) continue;

      const isIncremental = await rem.hasPowerup(powerupCode);
      const remText = await safeRemTextToString(plugin, rem.text);

      const foundPDF = await findPDFinRem(plugin, rem, pdfRemId);
      if (foundPDF && foundPDF._id === pdfRemId) {
        result.push({
          remId: rem._id,
          name: remText,
          isIncremental
        });
        processedRemIds.add(rem._id);
      }
    }

    // Sort: incremental first, then alphabetically
    result.sort((a, b) => {
      if (a.isIncremental !== b.isIncremental) {
        return a.isIncremental ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return result;
  } catch (error) {
    console.error('Error finding rems for PDF:', error);
    return [];
  }
};

/**
 * Find all rems (incremental and non-incremental) that use a specific HTML
 * article (Reader Mode source). Mirror of findAllRemsForPDF.
 */
export const findAllRemsForHTML = async (
  plugin: RNPlugin,
  htmlRemId: string
): Promise<Array<{
  remId: string;
  name: string;
  isIncremental: boolean;
}>> => {
  try {
    const result: Array<{
      remId: string;
      name: string;
      isIncremental: boolean;
    }> = [];

    const processedRemIds = new Set<string>();

    // PART 1: Search all incremental rems from cache
    const allIncrementalRems = await plugin.storage.getSession<IncrementalRem[]>(allIncrementalRemKey) || [];

    for (const incRemInfo of allIncrementalRems) {
      if (processedRemIds.has(incRemInfo.remId)) continue;

      const rem = await plugin.rem.findOne(incRemInfo.remId);
      if (!rem) continue;

      // Skip highlight rems — we want host-doc-level IncRems only
      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (isPdfHighlight) continue;

      const foundHtml = await findHTMLinRem(plugin, rem, htmlRemId);
      if (foundHtml && foundHtml._id === htmlRemId) {
        const remText = await safeRemTextToString(plugin, rem.text);
        result.push({
          remId: rem._id,
          name: remText,
          isIncremental: true
        });
        processedRemIds.add(rem._id);
      }
    }

    // PART 2: Check known rems from storage (non-incremental + cache-cold cases)
    const knownRemsKey = getKnownHtmlRemsKey(htmlRemId);
    const knownRemIds = (await plugin.storage.getSynced<string[]>(knownRemsKey)) || [];

    for (const remId of knownRemIds) {
      if (processedRemIds.has(remId)) continue;

      const rem = await plugin.rem.findOne(remId);
      if (!rem) continue;

      const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
      if (isPdfHighlight) continue;

      const isIncremental = await rem.hasPowerup(powerupCode);
      const remText = await safeRemTextToString(plugin, rem.text);

      const foundHtml = await findHTMLinRem(plugin, rem, htmlRemId);
      if (foundHtml && foundHtml._id === htmlRemId) {
        result.push({
          remId: rem._id,
          name: remText,
          isIncremental
        });
        processedRemIds.add(rem._id);
      }
    }

    result.sort((a, b) => {
      if (a.isIncremental !== b.isIncremental) {
        return a.isIncremental ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return result;
  } catch (error) {
    console.error('Error finding rems for HTML:', error);
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

/**
 * Generate key for storing a persistent list of rems known to be associated with an HTML page.
 */
export const getKnownHtmlRemsKey = (htmlRemId: string) => `known_html_rems_${htmlRemId}`;

/**
 * Finds a specific HTML/Link Rem within a given Rem or its sources.
 * Similar to findPDFinRem but for HTML/Link sources.
 * 
 * If targetHtmlId is provided, searches for that specific HTML rem.
 * If not provided, returns the first HTML link found.
 * 
 * NOTE: Excludes YouTube URLs since they are handled separately as 'youtube' type.
 */
export const findHTMLinRem = async (
  plugin: RNPlugin,
  rem: PluginRem,
  targetHtmlId?: string
): Promise<PluginRem | null> => {
  const isHtmlLink = async (r: PluginRem): Promise<boolean> => {
    const hasLink = await r.hasPowerup(BuiltInPowerupCodes.Link);
    if (!hasLink) return false;
    try {
      const url = await r.getPowerupProperty<BuiltInPowerupCodes.Link>(
        BuiltInPowerupCodes.Link,
        'URL'
      );
      // Check if it's a valid URL and not a YouTube URL
      if (url && typeof url === 'string') {
        const isYouTube = ['youtube', 'youtu.be'].some(x => url.toLowerCase().includes(x));
        return !isYouTube;
      }
      return false;
    } catch (e) {
      return false;
    }
  };

  // Check if rem itself is an HTML link
  if (await isHtmlLink(rem)) {
    if (!targetHtmlId || rem._id === targetHtmlId) {
      console.log(`    [findHTMLinRem] Rem itself is an HTML link (${rem._id})`);
      return rem;
    }
  }

  // Check sources
  const sources = await rem.getSources();
  console.log(`    [findHTMLinRem] Checking ${sources.length} sources`);

  const foundHtmlLinks: PluginRem[] = [];

  for (const source of sources) {
    if (await isHtmlLink(source)) {
      const sourceText = await safeRemTextToString(plugin, source.text);
      console.log(`    [findHTMLinRem] Found HTML link in source: "${sourceText}" (${source._id})`);
      foundHtmlLinks.push(source);

      // If we're looking for a specific HTML and found it, return immediately
      if (targetHtmlId && source._id === targetHtmlId) {
        console.log(`    [findHTMLinRem] ✓ MATCH! This is the target HTML`);
        return source;
      }
    }
  }

  // If we have a target HTML but didn't find it, return null
  if (targetHtmlId) {
    console.log(`    [findHTMLinRem] Found ${foundHtmlLinks.length} HTML link(s) but none matched target ${targetHtmlId}`);
    return null;
  }

  // If no target specified, return the first HTML link found (backward compatibility)
  return foundHtmlLinks.length > 0 ? foundHtmlLinks[0] : null;
};

/**
 * Check if a rem is an HTML source (has Link powerup with non-YouTube URL)
 */
export const isHtmlSource = async (rem: PluginRem): Promise<boolean> => {
  const hasLink = await rem.hasPowerup(BuiltInPowerupCodes.Link);
  if (!hasLink) return false;

  try {
    const url = await rem.getPowerupProperty<BuiltInPowerupCodes.Link>(
      BuiltInPowerupCodes.Link,
      'URL'
    );
    if (url && typeof url === 'string') {
      const isYouTube = ['youtube', 'youtu.be'].some(x => url.toLowerCase().includes(x));
      return !isYouTube;
    }
    return false;
  } catch (e) {
    return false;
  }
};

/**
 * Safely extracts the Front and Back content of a Rem.
 * Returns robust text representations for display headers.
 */
export async function getRemCardContent(
  plugin: RNPlugin,
  rem: PluginRem
): Promise<{ front: string; back: string }> {
  const front = await safeRemTextToString(plugin, rem.text);
  // rem.backText is available for Concept/Descriptor/Question rems with a back side
  const back = rem.backText ? await safeRemTextToString(plugin, rem.backText) : '';

  return { front, back };
}

/**
 * Extracts the host-document Rem ID and native Page index from a Reader highlight.
 *
 * Handles three highlight kinds with one signature:
 *   - PDF Reader highlight  → host has UploadedFile powerup, page from Data slot
 *   - PDF Text Reader highlight → host has UploadedFile powerup, no page
 *   - HTML article highlight (Reader Mode) → host has Link powerup, no page
 *
 * The returned `pdfRemId` is the host doc rem id regardless of source type
 * (name kept for backwards compatibility). `pageIndex` is null when the
 * source is non-paginated.
 */
export const getPdfInfoFromHighlight = async (
  plugin: RNPlugin,
  highlightRem: PluginRem
): Promise<{ pdfRemId: string | null; pageIndex: number | null }> => {
  let hostRemId: string | null = null;
  let pageIndex: number | null = null;

  try {
    // 1. Resolve page index via Data slot JSON. Only PDF Reader highlights
    //    populate this slot — Text Reader and HTML highlights leave it undefined.
    const dataString = await highlightRem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data');
    if (dataString) {
      const dataObj = JSON.parse(dataString);
      if (typeof dataObj.pageIndex === 'number') {
        pageIndex = dataObj.pageIndex + 1; // Native PDF pages are usually 0-indexed in PDFWebReader data
      } else if (dataObj.position && typeof dataObj.position.pageNumber === 'number') {
         pageIndex = dataObj.position.pageNumber; // as observed in test, might be 1-indexed
      }
    }

    // 2. Resolve host doc by walking up the parent chain. The host is whichever
    //    ancestor first identifies as a Reader source: UploadedFile (PDFs) or
    //    a non-YouTube Link (HTML articles).
    let cursor: PluginRem | undefined = highlightRem;
    while (cursor) {
      if (await cursor.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
        hostRemId = cursor._id;
        break;
      }
      if (await isHtmlSource(cursor)) {
        hostRemId = cursor._id;
        break;
      }
      const parent: PluginRem | undefined = await cursor.getParentRem();
      if (!parent) break;
      cursor = parent;
    }
  } catch (e) {
    console.error('[getPdfInfoFromHighlight] Error:', e);
  }

  return { pdfRemId: hostRemId, pageIndex };
};