import { BuiltInPowerupCodes, RNPlugin, PluginRem } from '@remnote/plugin-sdk';
import { ActionItemType, IncrementalRem } from './incremental_rem/types';
import { remToActionItemType } from './incremental_rem/action_items';

/**
 * Extract plain text from RemNote rich text format.
 * Handles strings, arrays with text items, and special content markers.
 */
export function extractText(text: unknown): string {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '[Complex content]';

  const result = text
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item?.text) return item.text;
      if (item?.i === 'q') return '[Quote]';
      if (item?.i === 'i') return '[Image]';
      if (item?.url) return '[Link]';
      return '';
    })
    .filter(Boolean)
    .join(' ');

  return result || '[Complex content]';
}

/**
 * Determine the type of an incremental rem (pdf, pdf-note, rem, etc).
 * Checks parent hierarchy to detect if it's a note under a PDF.
 */
export async function determineIncRemType(plugin: RNPlugin, rem: any): Promise<ActionItemType> {
  try {
    const actionItem = await remToActionItemType(plugin, rem);
    if (!actionItem) return 'unknown';

    let type: ActionItemType = actionItem.type;

    // Check if this is a note under a PDF
    if (type === 'rem') {
      let currentRem = rem;
      for (let i = 0; i < 20; i++) {
        const parent = await currentRem.getParentRem();
        if (!parent) break;
        if (await parent.hasPowerup(BuiltInPowerupCodes.UploadedFile)) {
          return 'pdf-note';
        }
        currentRem = parent;
      }
    }

    return type;
  } catch {
    return 'unknown';
  }
}

/**
 * Calculate the total time spent reviewing an incremental rem.
 * Sums up reviewTimeSeconds from all sessions in history.
 */
export function getTotalTimeSpent(incRem: IncrementalRem): number {
  if (!incRem.history || incRem.history.length === 0) return 0;
  return incRem.history.reduce((total, rep) => total + (rep.reviewTimeSeconds || 0), 0);
}

/**
 * Find the top-level document (root ancestor) for a rem.
 * Walks up the parent chain until finding a rem with no parent.
 */
export async function getTopLevelDocument(plugin: RNPlugin, rem: any): Promise<{ id: string; name: string } | null> {
  try {
    let current = rem;
    const maxDepth = 100;

    for (let i = 0; i < maxDepth; i++) {
      const parent = await current.getParentRem();
      if (!parent) {
        const text = await current.text;
        const name = extractText(text) || 'Untitled';
        return { id: current._id, name: name.length > 50 ? name.substring(0, 50) + '...' : name };
      }
      current = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Retrieves the source URL from an HTML type incremental rem.
 * 
 * HTML rems can have URLs in several places:
 * 1. Directly on the rem via Link powerup
 * 2. On a Source rem (when clipped via RemNote Clipper)
 * 3. For html-highlight, on the parent HTML document
 * 
 * @param plugin - RNPlugin instance
 * @param rem - The current rem being displayed
 * @param remType - The type of the rem ('html', 'html-highlight', etc.)
 * @returns The URL string or null if not found
 */
export const getHtmlSourceUrl = async (
  plugin: RNPlugin,
  rem: PluginRem | undefined,
  remType: string | null | undefined
): Promise<string | null> => {
  if (!rem) return null;

  try {
    // Helper function to extract URL from a rem that has the Link powerup
    const getUrlFromRem = async (r: PluginRem): Promise<string | null> => {
      const hasLink = await r.hasPowerup(BuiltInPowerupCodes.Link);
      if (hasLink) {
        const url = await r.getPowerupProperty<BuiltInPowerupCodes.Link>(
          BuiltInPowerupCodes.Link,
          'URL'
        );
        if (url && typeof url === 'string') {
          return url;
        }
      }
      return null;
    };

    // For direct HTML type rems
    if (remType === 'html') {
      // 1. First, check if the rem itself has the Link powerup
      const directUrl = await getUrlFromRem(rem);
      if (directUrl) {
        console.log('[getHtmlSourceUrl] Found URL directly on rem');
        return directUrl;
      }

      // 2. Check Sources - RemNote Clipper stores the URL on a source rem
      const sources = await rem.getSources();
      console.log('[getHtmlSourceUrl] Checking sources, count:', sources.length);

      for (const source of sources) {
        const sourceUrl = await getUrlFromRem(source);
        if (sourceUrl) {
          console.log('[getHtmlSourceUrl] Found URL on source rem');
          return sourceUrl;
        }
      }

      // 3. Check parent rem (sometimes the structure nests differently)
      const parent = await rem.getParentRem();
      if (parent) {
        const parentUrl = await getUrlFromRem(parent);
        if (parentUrl) {
          console.log('[getHtmlSourceUrl] Found URL on parent rem');
          return parentUrl;
        }

        // Also check parent's sources
        const parentSources = await parent.getSources();
        for (const source of parentSources) {
          const sourceUrl = await getUrlFromRem(source);
          if (sourceUrl) {
            console.log('[getHtmlSourceUrl] Found URL on parent source rem');
            return sourceUrl;
          }
        }
      }
    }

    // For HTML highlights, we need to get the URL from the source HTML document
    if (remType === 'html-highlight') {
      // The source HTML rem is stored via the HTMLId property
      const htmlIdRichText = await rem.getPowerupPropertyAsRichText<BuiltInPowerupCodes.HTMLHighlight>(
        BuiltInPowerupCodes.HTMLHighlight,
        'HTMLId'
      );

      // Extract the rem ID from the rich text (it's a reference)
      const htmlRemId = (htmlIdRichText?.[0] as any)?._id;

      if (htmlRemId) {
        const htmlRem = await plugin.rem.findOne(htmlRemId);
        if (htmlRem) {
          // Try to get URL from the HTML rem itself
          const directUrl = await getUrlFromRem(htmlRem);
          if (directUrl) {
            return directUrl;
          }

          // Check sources of the HTML rem
          const sources = await htmlRem.getSources();
          for (const source of sources) {
            const sourceUrl = await getUrlFromRem(source);
            if (sourceUrl) {
              return sourceUrl;
            }
          }
        }
      }
    }

    console.log('[getHtmlSourceUrl] No URL found after checking all locations');
    return null;
  } catch (error) {
    console.error('[getHtmlSourceUrl] Error:', error);
    return null;
  }
};

/**
 * Get a breadcrumb string for a rem (e.g. "Grandparent > Parent").
 * Traverses up to 5 levels deep.
 */
export async function getBreadcrumbText(plugin: RNPlugin, rem: any): Promise<string> {
  try {
    const parts: string[] = [];
    let current = rem;
    // We want ancestors, so start with parent
    let parent = await current.getParentRem();

    for (let i = 0; i < 5; i++) {
      if (!parent) break;
      const text = await parent.text;
      const name = extractText(text);
      if (name) {
        parts.unshift(name.length > 40 ? name.substring(0, 40) + '...' : name);
      }
      parent = await parent.getParentRem();
    }

    if (parts.length === 0) return '';
    return parts.join(' > ');
  } catch (error) {
    return '';
  }
}
